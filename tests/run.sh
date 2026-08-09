#!/usr/bin/env bash
#
# tests/run.sh - discovery-based test runner.
#
# Tests are found by GLOBBING tests/<suite>/*.test.sh. There is no list of test
# files anywhere, for the same reason bin/yan has no list of subcommands: the
# implementation phases land in parallel and must never conflict over a
# registry file.
#
# Suites:
#   unit/         stub level. No tmux, no network, no forge.
#   integration/  real git against local bare remotes, and real tmux.
#   e2e/          real forge / real agent CLI. Opt-in only.
#
set -uo pipefail

TESTS_DIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
REPO_ROOT=$(dirname "$TESTS_DIR")

suites=(unit integration)
filter=
run_tests=1
run_lint=1

usage() {
	cat <<'EOF'
usage: tests/run.sh [--fast | --e2e] [--filter <substring>] [--lint]

  (no flags)            unit + integration, then shellcheck
  --fast                unit only, no lint
  --e2e                 unit + integration + e2e, then shellcheck
  --filter <substring>  only run test files whose path contains <substring>
  --lint                shellcheck only
EOF
}

while [ $# -gt 0 ]; do
	case $1 in
	--fast)
		suites=(unit)
		run_lint=0
		;;
	--e2e)
		suites=(unit integration e2e)
		;;
	--filter)
		shift
		filter=${1:-}
		if [ -z "$filter" ]; then
			printf 'run.sh: --filter needs a substring\n' >&2
			exit 2
		fi
		;;
	--lint)
		run_tests=0
		run_lint=1
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		printf 'run.sh: unknown flag: %s\n\n' "$1" >&2
		usage >&2
		exit 2
		;;
	esac
	shift
done

indent() {
	local line
	while IFS= read -r line; do
		printf '      %s\n' "$line"
	done
}

# Which runtime are we on? yan supports exactly two, and a failure that only
# reproduces on one of them is the most expensive kind, so every run says so
# out loud.
case "$(uname -s 2>/dev/null)" in
MINGW* | MSYS* | CYGWIN*) platform='Git Bash (Windows / MSYS2)' ;;
Linux*)
	if [ -r /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null; then
		platform='Linux (WSL)'
	else
		platform='Linux'
	fi
	;;
Darwin*) platform='macOS (unsupported)' ;;
*) platform="unknown ($(uname -s 2>/dev/null || printf '?'))" ;;
esac
printf 'platform: %s | bash %s\n\n' "$platform" "${BASH_VERSION:-?}"

discover() {
	local suite f
	for suite in "${suites[@]}"; do
		(
			shopt -s nullglob
			for f in "$TESTS_DIR/$suite"/*.test.sh; do
				printf '%s\n' "$f"
			done
		)
	done | LC_ALL=C sort
}

lint_targets() {
	local f
	(
		shopt -s nullglob
		for f in "$REPO_ROOT"/bin/*; do
			if [ -f "$f" ]; then
				printf '%s\n' "$f"
			fi
		done
	)
	find "$TESTS_DIR" -type f -name '*.sh' | LC_ALL=C sort
}

passed=0
failed=0
failed_names=()

if [ "$run_tests" -eq 1 ]; then
	while IFS= read -r file; do
		[ -n "$file" ] || continue
		name=${file#"$REPO_ROOT"/}
		if [ -n "$filter" ]; then
			case $name in
			*"$filter"*) ;;
			*) continue ;;
			esac
		fi

		rc=0
		out=$(env -u YAN_HOME -u YAN_LIB bash "$file" 2>&1) || rc=$?
		if [ "$rc" -eq 0 ]; then
			passed=$((passed + 1))
			printf 'PASS  %s\n' "$name"
		else
			failed=$((failed + 1))
			failed_names+=("$name")
			printf 'FAIL  %s (exit %d)\n' "$name" "$rc"
			printf '%s\n' "$out" | indent
		fi
	done < <(discover)

	if [ "$passed" -eq 0 ] && [ "$failed" -eq 0 ]; then
		printf 'run.sh: no tests matched\n' >&2
	fi
fi

lint_rc=0
if [ "$run_lint" -eq 1 ]; then
	if command -v shellcheck >/dev/null 2>&1; then
		files=()
		while IFS= read -r f; do
			[ -n "$f" ] && files+=("$f")
		done < <(lint_targets)

		if [ "${#files[@]}" -eq 0 ]; then
			printf 'LINT  SKIP  nothing to lint\n'
		else
			# -x follows `. other.sh` so helpers defined in assert.sh and the
			# libraries are seen; -P resolves the `# shellcheck source=` paths
			# relative to the repository root.
			out=$(shellcheck --severity=warning -x -P "$REPO_ROOT" "${files[@]}" 2>&1) || lint_rc=$?
			if [ "$lint_rc" -eq 0 ]; then
				printf 'LINT  PASS  shellcheck (%d files, severity=warning)\n' "${#files[@]}"
			else
				printf 'LINT  FAIL  shellcheck (%d files)\n' "${#files[@]}"
				printf '%s\n' "$out" | indent
			fi
		fi
	else
		printf 'LINT  SKIP  shellcheck is not on PATH - install it to lint shell sources\n'
	fi
fi

printf '\n%d passed, %d failed' "$passed" "$failed"
if [ "$run_lint" -eq 1 ]; then
	if [ "$lint_rc" -eq 0 ]; then
		printf ', lint ok'
	else
		printf ', lint FAILED'
	fi
fi
printf '\n'

if [ "$failed" -gt 0 ]; then
	printf '\nfailed tests:\n'
	for name in "${failed_names[@]}"; do
		printf '  %s\n' "$name"
	done
	exit 1
fi
[ "$lint_rc" -eq 0 ] || exit 1
exit 0
