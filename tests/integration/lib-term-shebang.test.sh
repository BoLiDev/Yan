#!/usr/bin/env bash
#
# An agent CLI that is a SHEBANG SCRIPT must start in a pane.
#
# On Windows every agent is launched through winpty, and winpty starts a NATIVE
# Windows process - so handed a script it fails with
#
#   winpty: error: cannot start '.../cli': %1 is not a valid Win32 application.
#
# and the pane dies before the agent prints anything. Reproduced in a real pane:
# `winpty ./script` exits 1, `winpty bash ./script` exits 0.
#
# This is not a hypothetical shape. The MVP accepts any shift CLI meeting
# td §5.6, and an npm-installed CLI resolves to a shell-script shim under Git
# Bash. `claude` on this machine happens to be a genuine .exe, which is exactly
# why the Phase 3 e2e passed and never surfaced this.
#
# On Linux there is no winpty and a shebang script has always started fine, so
# this test asserts the same outcome on both platforms rather than branching:
# the agent runs, and its output is readable.
#
set -euo pipefail

TDIR=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)
# shellcheck source=tests/assert.sh
. "$TDIR/assert.sh"
# shellcheck source=tests/fixtures.sh
. "$TDIR/fixtures.sh"

if ! command -v tmux >/dev/null 2>&1; then
	printf 'SKIP  tmux is not on PATH\n'
	exit 0
fi

tmp=$(mktemp -d)
run_id="yan-shebang-test-$$-${RANDOM}"
container="$run_id container"

cleanup() {
	tmux kill-session -t "=$container" >/dev/null 2>&1 || true
	rm -rf "$tmp"
}
trap cleanup EXIT

home=$tmp/home
mk_yan_home "$home"
export YAN_HOME=$home

# shellcheck source=bin/lib-term.sh
. "$YAN_REPO_ROOT/bin/lib-term.sh"

# A stand-in agent CLI in exactly the shape that breaks: a shebang script, on
# PATH, executable. It prints a marker and then idles, so the pane stays alive
# long enough to read it.
bindir=$tmp/bin
mkdir -p "$bindir"
cat >"$bindir/fake-agent" <<'EOF'
#!/usr/bin/env bash
printf 'FAKE_AGENT_STARTED arg=%s\n' "${1:-none}"
sleep 30
EOF
chmod +x "$bindir/fake-agent"
PATH=$bindir:$PATH
export PATH

sid=$(term_container_create "$container")
assert_ne '' "$sid" "the container must have an id"

ids=$(term_agent_start "$sid" shifty fake-agent hello)
assert_ne '' "$ids" "term_agent_start must return the window and pane ids"

# Poll rather than sleep a fixed amount: a cold winpty start is slow on Windows.
found=1
waited=0
while [ "$waited" -lt 150 ]; do
	# Not `term_read | grep -q`: under `set -o pipefail` grep exits early, the
	# producer takes SIGPIPE, and the pipeline reports failure despite a match.
	case "$(term_read "${ids##* }" 200 2>/dev/null || true)" in
	*FAKE_AGENT_STARTED*)
		found=0
		break
		;;
	esac
	sleep 0.2 2>/dev/null || sleep 1
	waited=$((waited + 1))
done

if [ "$found" -ne 0 ]; then
	_assert_die "a shebang-script agent never started in its pane" \
		"pane said: $(term_read "${ids##* }" 200 2>/dev/null || true)"
fi

# The argument has to survive the wrapping too - a naive fix that hands the
# whole command string to an interpreter can lose or re-split arguments.
case "$(term_read "${ids##* }" 200 2>/dev/null || true)" in
*'arg=hello'*) ;;
*) _assert_die "the agent's argument did not survive the winpty wrapping" \
	"pane said: $(term_read "${ids##* }" 200 2>/dev/null || true)" ;;
esac

# And it is genuinely alive, not a pane that printed and died.
assert_eq alive "$(term_agent_alive "${ids%% *}")" "the agent must still be running"

term_agent_close "${ids%% *}" >/dev/null 2>&1 || true
