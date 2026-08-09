# shellcheck shell=bash
#
# lib-forge.sh - the remote git seam (td delivery.md §8.4, architecture.md §4.3).
#
# Everything that opens, queries or merges an MR, and everything that asks
# about CI, goes through this file. Callers speak forge vocabulary only. They
# never learn whether the repository lives on GitHub or on GitLab.
#
#     forge_mr_create   open an MR/PR, print its URL
#     forge_mr_state    merged | closed | open | unknown
#     forge_mr_merge    merge it
#     forge_ci_state    green | red | pending | none
#
# Four verbs over a thick implementation. Underneath they hide five differences
# between the two CLIs:
#
#   1. argument shapes    gh --base/--head/--body   vs  glab -b/-s/-d, and
#                         glab's --auto-merge default of TRUE, which would
#                         silently turn "merge it" into "merge it later";
#   2. terminology        pull request vs merge request, `pull/N` vs
#                         `merge_requests/N` in URLs, and an MR reference that
#                         gh takes verbatim but glab needs split into an iid
#                         plus a project path;
#   3. JSON shapes        GraphQL-ish CamelCase (state/mergedAt/
#                         statusCheckRollup) vs REST snake_case (state/
#                         merged_at/head_pipeline);
#   4. authentication     gh and glab each own their login. This layer does NOT
#                         paper over that - it only routes to the right host
#                         (GH_HOST / GITLAB_HOST) so the CLI can find the
#                         credentials it already has. `yan doctor` is where a
#                         missing login is reported;
#   5. the CI model       GitLab has one pipeline with one status; GitHub has N
#                         check runs PLUS the legacy commit-status API, mixed
#                         together in one rollup array.
#
# The failure mode to guard against is this file degrading into a shallow
# module - one-line pass-throughs, the outside tool's own words leaking out,
# and the caller still having to know which system it is talking to. The
# defence is that the interface is written in yan's vocabulary, not in the
# union of the two forges' vocabularies:
#
#   * a merge request is identified by the URL forge_mr_create returned (or a
#     plain number). Turning that into what each CLI wants is this file's job;
#   * a repository is named with --repo <slug> or --dir <path>, never with a
#     provider-specific flag;
#   * the merge strategy is --strategy merge|squash|rebase for both;
#   * RETURN VALUES ARE A CLOSED SET DEFINED BY YAN. Every path out of
#     forge_mr_state goes through _forge_gate_mr_state and every path out of
#     forge_ci_state goes through _forge_gate_ci_state, so a fifth value cannot
#     slip in even by accident.
#
# The four values of forge_mr_state exist because branching.md §6.4 needs
# exactly those four to decide a round's `end`: merged -> delivered, closed ->
# abandoned, open -> the round is not over, unknown -> ask user.
#
# CI answers only green or red (plus pending and none) on purpose. "Which job
# failed" does not line up between the two providers and forcing it to would
# drop information. What the caller needs is "CI is red". Which job, and why,
# is the shift's business - and a shift may know which forge it is on, because
# it is reading, not deciding.
#
# Three seam rules from architecture.md §4.3 hold here:
#   - seams never call other seams (this file uses git and jq, no lib-term,
#     no lib-pool, no lib-hook);
#   - seams report facts and decide nothing. `red` is a fact; "red means
#     dispatch a shift" is the subcommand's business;
#   - seams never write bookkeeping under $YAN_HOME. The only file this
#     library creates is a short-lived temp file for a CLI's stderr.
#
# Exit status:
#   0   an answer was produced (for the two query verbs, always a value from
#       the closed set - including when the forge could not be reached, which
#       is reported as `unknown` / `pending` plus a note on stderr; a caller
#       running under `set -e` therefore branches on the value, never crashes);
#   2   you called this wrongly, or this machine's forge configuration is
#       unusable (`yan doctor` explains it);
#   1   the action did not work (forge_mr_create / forge_mr_merge only).
#
# Configuration: this file is the ONLY reader of conf/config.json's `forge`
# section. Subcommands never branch on forge.kind. The single sanctioned
# exception is bin/lib-boot.sh, which has to name the missing CLI before this
# library could ever run; tests/unit/lib-boot-forge.test.sh keeps the two in
# step. Config is read with jq directly, exactly as lib-boot does, so that
# sourcing this library never requires $YAN_HOME to be set.

if [ -n "${_YAN_LIB_FORGE_SOURCED:-}" ]; then
	return 0
fi
_YAN_LIB_FORGE_SOURCED=1

_forge_err() {
	printf 'lib-forge: %s\n' "$1" >&2
}

# CARRIAGE RETURNS.
#
# jq.exe on Git Bash writes CRLF, and gh.exe and glab.exe are native Windows
# programs that do the same. `$(...)` hides it for a single line - bash drops
# the trailing CRLF - so the damage only shows up on multi-line output, where
# every line but the last keeps a stray CR, and an exact comparison against a
# closed set then fails for no visible reason. Every value this library reads
# back from jq or from a forge CLI is stripped with ${v//$'\r'/} before it is
# compared or returned. Grep this file for \r to find them all.

# --- the closed sets -------------------------------------------------------
#
# These two gates are the last statement on every path out of the two query
# verbs. Nothing else is allowed to write to stdout from them. If a mapper or
# a provider branch ever produces something else, the gate turns it into the
# safe member of the set and says so, rather than leaking a fifth value.

_forge_gate_mr_state() {
	case ${1-} in
	merged | closed | open | unknown) printf '%s\n' "$1" ;;
	*)
		_forge_err "internal: '${1-}' is not a merge request state - reporting unknown"
		printf 'unknown\n'
		;;
	esac
}

# `pending` is the safe member for CI: it means "no answer yet, ask again".
# `green` would be dangerous, `red` would send a shift to fix nothing, and
# `none` would claim this repository has no CI at all.
_forge_gate_ci_state() {
	case ${1-} in
	green | red | pending | none) printf '%s\n' "$1" ;;
	*)
		_forge_err "internal: '${1-}' is not a CI state - reporting pending"
		printf 'pending\n'
		;;
	esac
}

# --- configuration ---------------------------------------------------------

_forge_config_path() {
	if [ -z "${YAN_HOME:-}" ]; then
		_forge_err "YAN_HOME is not set - run this through bin/yan"
		return 2
	fi
	printf '%s/conf/config.json\n' "$YAN_HOME"
}

# _forge_config_get <jq-filter> - prints the value, or nothing when unset.
_forge_config_get() {
	local cfg
	cfg=$(_forge_config_path) || return $?
	if [ ! -f "$cfg" ]; then
		_forge_err "no configuration at $cfg - copy conf/config.sample.json there and set forge.kind"
		return 2
	fi
	local v
	if ! v=$(jq -r "$1 // empty" "$cfg" 2>/dev/null); then
		_forge_err "cannot read $cfg - it is not valid JSON; run 'yan doctor'"
		return 2
	fi
	printf '%s\n' "${v//$'\r'/}"
}

# _forge_kind - github | gitlab. Exit 2 on anything else, because a machine
# that cannot say which forge it uses cannot be asked about merge requests.
_forge_kind() {
	local kind
	kind=$(_forge_config_get '.forge.kind') || return $?
	case $kind in
	github | gitlab) printf '%s\n' "$kind" ;;
	'')
		_forge_err "forge.kind is not set in $(_forge_config_path) - set it to github or gitlab, then run 'yan doctor'"
		return 2
		;;
	*)
		_forge_err "forge.kind is '$kind', which yan does not support - use github or gitlab"
		return 2
		;;
	esac
}

_forge_config_host() { _forge_config_get '.forge.host'; }

# --- the caller's vocabulary ----------------------------------------------
#
# Yan's own flags. No gh or glab flag is ever accepted here: a caller cannot
# smuggle `--admin` or `--auto-merge` through, because every verb declares the
# flags it takes and the parser refuses everything else.

_forge_repo=
_forge_dir=
_forge_mr=
_forge_source=
_forge_target=
_forge_title=
_forge_body=
_forge_body_file=
_forge_draft=0
_forge_strategy=merge
_forge_delete_source=0
_forge_allow=
_forge_stdout=
_forge_stderr=
_forge_ref_args=()
_forge_gh_host=
_forge_glab_host=

_forge_reset() {
	_forge_repo=
	_forge_dir=
	_forge_mr=
	_forge_source=
	_forge_target=
	_forge_title=
	_forge_body=
	_forge_body_file=
	_forge_draft=0
	_forge_strategy=merge
	_forge_delete_source=0
	_forge_stdout=
	_forge_stderr=
	_forge_ref_args=()
}

_forge_allowed() {
	case " $_forge_allow " in
	*" $1 "*) return 0 ;;
	esac
	_forge_err "--$1 is not accepted here - see the verb's flag list in lib-forge.sh"
	return 2
}

# _forge_begin "<allowed-flags>" <args...>
_forge_begin() {
	_forge_reset
	_forge_allow=$1
	shift

	while [ $# -gt 0 ]; do
		case $1 in
		--draft)
			_forge_allowed draft || return 2
			_forge_draft=1
			shift
			;;
		--delete-source)
			_forge_allowed delete-source || return 2
			_forge_delete_source=1
			shift
			;;
		--repo | --dir | --mr | --source | --target | --title | --body | --body-file | --strategy)
			_forge_allowed "${1#--}" || return 2
			if [ $# -lt 2 ]; then
				_forge_err "$1 needs a value"
				return 2
			fi
			# The identifiers are stripped of carriage returns; a URL or a
			# branch name that arrived from a JSON file read on Git Bash may
			# carry one, and it would turn into an unexplainable 404. --title,
			# --body and --body-file are left alone: prose may legitimately
			# contain CRLF.
			case ${1#--} in
			repo) _forge_repo=${2//$'\r'/} ;;
			dir) _forge_dir=${2//$'\r'/} ;;
			mr) _forge_mr=${2//$'\r'/} ;;
			source) _forge_source=${2//$'\r'/} ;;
			target) _forge_target=${2//$'\r'/} ;;
			title) _forge_title=$2 ;;
			body) _forge_body=$2 ;;
			body-file) _forge_body_file=$2 ;;
			strategy) _forge_strategy=${2//$'\r'/} ;;
			esac
			shift 2
			;;
		*)
			_forge_err "unknown option: $1 - forge verbs take yan's own flags only, never gh's or glab's"
			return 2
			;;
		esac
	done
}

_forge_need_mr() {
	if [ -z "$_forge_mr" ]; then
		_forge_err "--mr is required - pass the merge request URL forge_mr_create returned, or its number"
		return 2
	fi
}

_forge_need_dir() {
	if [ -n "$_forge_dir" ] && [ ! -d "$_forge_dir" ]; then
		_forge_err "--dir is not a directory: $_forge_dir"
		return 2
	fi
}

# _forge_body_text - the MR description, from --body or --body-file.
_forge_body_text() {
	if [ -n "$_forge_body_file" ]; then
		if [ ! -f "$_forge_body_file" ]; then
			_forge_err "--body-file does not exist: $_forge_body_file"
			return 2
		fi
		cat -- "$_forge_body_file"
		return 0
	fi
	printf '%s' "$_forge_body"
}

# --- running a forge CLI ---------------------------------------------------

# _forge_query <cli> <args...>
#
# Sets _forge_stdout and _forge_stderr and returns the CLI's exit status.
# stderr is captured rather than merged, because merging it would corrupt the
# JSON on stdout the moment a CLI printed a deprecation notice - and a mapper
# fed corrupted JSON would answer `unknown` for a perfectly healthy MR.
_forge_query() {
	local cli=$1 errf rc=0
	shift

	errf=$(mktemp "${TMPDIR:-/tmp}/yan-forge.XXXXXX") || {
		_forge_err "cannot create a temporary file - check TMPDIR"
		return 1
	}
	_forge_stdout=$(_forge_invoke "$cli" "$@" 2>"$errf") || rc=$?
	_forge_stderr=$(cat "$errf" 2>/dev/null || printf '')
	rm -f -- "$errf"
	# gh.exe and glab.exe are native Windows programs: their output arrives
	# CRLF-terminated on Git Bash. Strip it here, once, so neither the JSON
	# mappers nor the URL extractor ever has to think about it.
	_forge_stdout=${_forge_stdout//$'\r'/}
	_forge_stderr=${_forge_stderr//$'\r'/}
	return "$rc"
}

_forge_invoke() {
	local cli=$1
	shift
	if [ -n "$_forge_dir" ]; then
		(cd -- "$_forge_dir" && _forge_exec "$cli" "$@")
	else
		_forge_exec "$cli" "$@"
	fi
}

# _forge_exec - the one place a forge CLI is actually executed.
#
# Host routing lives here. It is NOT authentication: gh and glab each keep
# their own login, and naming the host only tells the CLI which of its own
# stored credentials to use.
_forge_exec() {
	local cli=$1
	shift
	if ! command -v "$cli" >/dev/null 2>&1; then
		printf 'lib-forge: %s is not on PATH - install it, then run '\''yan doctor'\''\n' "$cli" >&2
		return 127
	fi
	case $cli in
	gh)
		if [ -n "${_forge_gh_host:-}" ]; then
			GH_HOST=$_forge_gh_host gh "$@"
		else
			gh "$@"
		fi
		;;
	glab)
		if [ -n "${_forge_glab_host:-}" ]; then
			GITLAB_HOST=$_forge_glab_host glab "$@"
		else
			glab "$@"
		fi
		;;
	*)
		"$cli" "$@"
		;;
	esac
}

_forge_unreachable_note() {
	local what=$1 fallback=$2 detail=${_forge_stderr:-}
	detail=$(printf '%s' "$detail" | tr '\n' ' ')
	_forge_err "cannot ask the forge about $what - reporting $fallback${detail:+ ($detail)}"
}

# --- GitHub ----------------------------------------------------------------

_forge_github_setup() {
	local host
	host=$(_forge_config_host) || return $?
	_forge_gh_host=
	case $host in
	'' | github.com) ;;
	*) _forge_gh_host=$host ;;
	esac
}

# _forge_github_ref - gh takes a number, a URL or a branch verbatim. A URL
# already names the repository, so --repo would only be a chance to disagree
# with it.
_forge_github_ref() {
	_forge_ref_args=("$_forge_mr")
	case $_forge_mr in
	http://* | https://*) ;;
	*)
		if [ -n "$_forge_repo" ]; then
			_forge_ref_args+=(--repo "$_forge_repo")
		fi
		;;
	esac
}

# _forge_github_map_mr_state <json> - raw `gh pr view --json state,mergedAt`
# to yan vocabulary. Pure: no network, no configuration, no globals.
#
# `mergedAt` (REST: `merged`) is consulted before `state`, and deliberately so:
# a SQUASH-merged pull request is merged even though its head commit is not an
# ancestor of the base branch and its branch may already be deleted. Local git
# ancestry is not the question; what the forge says is.
_forge_github_map_mr_state() {
	local v
	v=$(printf '%s' "${1-}" | jq -r '
		if type != "object" then "unknown"
		elif (.mergedAt // null) != null then "merged"
		elif (.merged // false) == true then "merged"
		else
			((.state // "") | ascii_downcase) as $s
			| if $s == "merged" then "merged"
			  elif $s == "closed" then "closed"
			  elif $s == "open" then "open"
			  else "unknown" end
		end
	' 2>/dev/null) || v=unknown
	v=${v//$'\r'/}
	case $v in
	merged | closed | open) printf '%s\n' "$v" ;;
	*) printf 'unknown\n' ;;
	esac
}

# _forge_github_map_ci_state <json> - raw `gh pr view --json statusCheckRollup`
# to yan vocabulary. Pure.
#
# The rollup is where GitHub's two CI systems meet in one array:
#
#   CheckRun       (checks API)  status QUEUED|IN_PROGRESS|COMPLETED|...
#                                conclusion SUCCESS|FAILURE|SKIPPED|...
#   StatusContext  (legacy)      state EXPECTED|PENDING|SUCCESS|FAILURE|ERROR
#
# Both are collapsed to one word per entry and then folded with a fixed
# precedence: RED BEATS PENDING BEATS GREEN. A failure is a settled fact and
# the caller can act on it now; waiting for the rest of a run that has already
# failed only delays the fix.
#
# Per-entry rules:
#   green    success, neutral, skipped  - nothing is blocking
#   pending  not finished yet, or a conclusion of `stale` (GitHub supersedes
#            those, so they are neither a pass nor a failure)
#   red      failure, timed_out, cancelled, action_required, startup_failure,
#            and anything else terminal we do not recognise
#
# An empty rollup is `none`: this repository ran no CI for this MR. A payload
# with no rollup key at all is not `none` - that would be a confident wrong
# answer - it is `pending`.
_forge_github_map_ci_state() {
	local v
	v=$(printf '%s' "${1-}" | jq -r '
		(if type == "array" then .
		 elif type == "object" and has("statusCheckRollup")
		 then (.statusCheckRollup // [])
		 else null end) as $rollup
		| if $rollup == null or ($rollup | type) != "array" then "pending"
		  elif ($rollup | length) == 0 then "none"
		  else
			[ $rollup[]
			  | if (.__typename // "") == "StatusContext"
				 or (has("state") and (has("status") | not))
				then
					((.state // "") | ascii_downcase) as $s
					| if $s == "success" then "green"
					  elif $s == "failure" or $s == "error" then "red"
					  else "pending" end
				else
					((.status // "") | ascii_downcase) as $st
					| ((.conclusion // "") | ascii_downcase) as $c
					| if $st != "completed" then "pending"
					  elif $c == "success" or $c == "neutral" or $c == "skipped" then "green"
					  elif $c == "" or $c == "stale" then "pending"
					  else "red" end
				end
			] as $words
			| if ($words | index("red")) != null then "red"
			  elif ($words | index("pending")) != null then "pending"
			  else "green" end
		  end
	' 2>/dev/null) || v=pending
	v=${v//$'\r'/}
	case $v in
	green | red | pending | none) printf '%s\n' "$v" ;;
	*) printf 'pending\n' ;;
	esac
}

_forge_github_mr_state() {
	_forge_github_setup || return $?
	_forge_github_ref
	if ! _forge_query gh pr view "${_forge_ref_args[@]}" --json state,mergedAt; then
		_forge_unreachable_note "$_forge_mr" unknown
		_forge_gate_mr_state unknown
		return 0
	fi
	_forge_gate_mr_state "$(_forge_github_map_mr_state "$_forge_stdout")"
}

_forge_github_ci_state() {
	_forge_github_setup || return $?
	_forge_github_ref
	if ! _forge_query gh pr view "${_forge_ref_args[@]}" --json statusCheckRollup; then
		_forge_unreachable_note "CI for $_forge_mr" pending
		_forge_gate_ci_state pending
		return 0
	fi
	_forge_gate_ci_state "$(_forge_github_map_ci_state "$_forge_stdout")"
}

_forge_github_mr_create() {
	local body args=()
	_forge_github_setup || return $?
	body=$(_forge_body_text) || return $?

	args=(pr create --base "$_forge_target" --head "$_forge_source"
		--title "$_forge_title" --body "$body")
	if [ "$_forge_draft" -eq 1 ]; then
		args+=(--draft)
	fi
	if [ -n "$_forge_repo" ]; then
		args+=(--repo "$_forge_repo")
	fi

	if ! _forge_query gh "${args[@]}"; then
		_forge_err "could not open the pull request${_forge_stderr:+ - $(printf '%s' "$_forge_stderr" | tr '\n' ' ')}"
		return 1
	fi
	_forge_extract_url "$_forge_stdout" 'https?://[^[:space:]]+/pull/[0-9]+'
}

_forge_github_mr_merge() {
	local args=()
	_forge_github_setup || return $?
	_forge_github_ref

	args=(pr merge "${_forge_ref_args[@]}")
	case $_forge_strategy in
	merge) args+=(--merge) ;;
	squash) args+=(--squash) ;;
	rebase) args+=(--rebase) ;;
	esac
	if [ "$_forge_delete_source" -eq 1 ]; then
		args+=(--delete-branch)
	fi

	if ! _forge_query gh "${args[@]}"; then
		_forge_err "could not merge $_forge_mr${_forge_stderr:+ - $(printf '%s' "$_forge_stderr" | tr '\n' ' ')}"
		return 1
	fi
}

# --- GitLab ----------------------------------------------------------------

_forge_gitlab_setup() {
	local host
	host=$(_forge_config_host) || return $?
	if [ -z "$host" ]; then
		_forge_err "forge.host is required when forge.kind is gitlab - set it in $(_forge_config_path) (hostname, no scheme), then run 'yan doctor'"
		return 2
	fi
	_forge_glab_host=$host
}

# _forge_gitlab_ref - glab wants an iid, not a URL. A yan merge request
# reference is usually the URL that forge_mr_create returned, so splitting it
# into "which project" and "which number" happens here, once, instead of at
# every call site.
_forge_gitlab_ref() {
	local iid=$_forge_mr repo=$_forge_repo rest

	case $_forge_mr in
	http://* | https://*)
		iid=${_forge_mr##*/merge_requests/}
		iid=${iid%%/*}
		iid=${iid%%\?*}
		iid=${iid%%#*}
		if [ -z "$repo" ]; then
			rest=${_forge_mr%%/-/merge_requests/*}
			if [ "$rest" = "$_forge_mr" ]; then
				rest=${_forge_mr%%/merge_requests/*}
			fi
			rest=${rest#*://}
			repo=${rest#*/}
		fi
		;;
	esac

	case $iid in
	'' | *[!0-9]*)
		_forge_err "cannot work out the merge request number from '$_forge_mr' - pass --mr <number> or a full merge request URL"
		return 2
		;;
	esac

	_forge_ref_args=("$iid")
	if [ -n "$repo" ]; then
		_forge_ref_args+=(--repo "$repo")
	fi
}

# _forge_gitlab_map_mr_state <json> - raw `glab mr view -F json` to yan
# vocabulary. Pure.
#
# GitLab has four MR states where yan has three plus unknown: `locked` is an
# open merge request whose discussion is locked, so it collapses onto `open`.
# That collapse is the point - a fifth value is not allowed to reach §6.4.
_forge_gitlab_map_mr_state() {
	local v
	v=$(printf '%s' "${1-}" | jq -r '
		if type != "object" then "unknown"
		elif (.merged_at // null) != null then "merged"
		else
			((.state // "") | ascii_downcase) as $s
			| if $s == "merged" then "merged"
			  elif $s == "closed" then "closed"
			  elif $s == "opened" or $s == "locked" then "open"
			  else "unknown" end
		end
	' 2>/dev/null) || v=unknown
	v=${v//$'\r'/}
	case $v in
	merged | closed | open) printf '%s\n' "$v" ;;
	*) printf 'unknown\n' ;;
	esac
}

# _forge_gitlab_map_ci_state <json> - raw `glab mr view -F json` to yan
# vocabulary. Pure.
#
# One MR, one pipeline, one status - the opposite of GitHub's array. The MR
# payload carries it as `head_pipeline` (older GitLab: `pipeline`).
#
#   green    success
#   red      failed, canceled - a cancelled pipeline did not pass
#   pending  created, waiting_for_resource, preparing, pending, running,
#            manual (waiting for a human to press play), scheduled, canceling
#   none     no pipeline at all, or a skipped one: nothing ran
_forge_gitlab_map_ci_state() {
	local v
	v=$(printf '%s' "${1-}" | jq -r '
		if type != "object" then "pending"
		else
			(.head_pipeline // .pipeline // null) as $p
			| if $p == null then "none"
			  elif ($p | type) != "object" then "pending"
			  else
				(($p.status // "") | ascii_downcase) as $s
				| if $s == "success" then "green"
				  elif $s == "failed" or $s == "canceled" or $s == "cancelled" then "red"
				  elif $s == "skipped" then "none"
				  elif $s == "" then "pending"
				  else "pending" end
			  end
		end
	' 2>/dev/null) || v=pending
	v=${v//$'\r'/}
	case $v in
	green | red | pending | none) printf '%s\n' "$v" ;;
	*) printf 'pending\n' ;;
	esac
}

_forge_gitlab_mr_state() {
	_forge_gitlab_setup || return $?
	_forge_gitlab_ref || return $?
	if ! _forge_query glab mr view "${_forge_ref_args[@]}" --output json; then
		_forge_unreachable_note "$_forge_mr" unknown
		_forge_gate_mr_state unknown
		return 0
	fi
	_forge_gate_mr_state "$(_forge_gitlab_map_mr_state "$_forge_stdout")"
}

_forge_gitlab_ci_state() {
	_forge_gitlab_setup || return $?
	_forge_gitlab_ref || return $?
	if ! _forge_query glab mr view "${_forge_ref_args[@]}" --output json; then
		_forge_unreachable_note "CI for $_forge_mr" pending
		_forge_gate_ci_state pending
		return 0
	fi
	_forge_gate_ci_state "$(_forge_gitlab_map_ci_state "$_forge_stdout")"
}

_forge_gitlab_mr_create() {
	local body args=()
	_forge_gitlab_setup || return $?
	body=$(_forge_body_text) || return $?

	# --yes and --no-editor together are what make this non-interactive; glab
	# otherwise opens an editor and waits, which inside a tmux pane looks like
	# a hang.
	args=(mr create --source-branch "$_forge_source" --target-branch "$_forge_target"
		--title "$_forge_title" --description "$body" --no-editor --yes)
	if [ "$_forge_draft" -eq 1 ]; then
		args+=(--draft)
	fi
	if [ -n "$_forge_repo" ]; then
		args+=(--repo "$_forge_repo")
	fi

	if ! _forge_query glab "${args[@]}"; then
		_forge_err "could not open the merge request${_forge_stderr:+ - $(printf '%s' "$_forge_stderr" | tr '\n' ' ')}"
		return 1
	fi
	_forge_extract_url "$_forge_stdout$_forge_stderr" 'https?://[^[:space:]]+/merge_requests/[0-9]+'
}

_forge_gitlab_mr_merge() {
	local args=()
	_forge_gitlab_setup || return $?
	_forge_gitlab_ref || return $?

	# --auto-merge defaults to TRUE in glab: with a pipeline running it would
	# schedule the merge and report success without merging anything. yan's
	# verb means "merge it now", so the default is turned off here rather than
	# left for every caller to remember.
	args=(mr merge "${_forge_ref_args[@]}" --yes --auto-merge=false)
	case $_forge_strategy in
	merge) ;;
	squash) args+=(--squash) ;;
	rebase) args+=(--rebase) ;;
	esac
	if [ "$_forge_delete_source" -eq 1 ]; then
		args+=(--remove-source-branch)
	fi

	if ! _forge_query glab "${args[@]}"; then
		_forge_err "could not merge $_forge_mr${_forge_stderr:+ - $(printf '%s' "$_forge_stderr" | tr '\n' ' ')}"
		return 1
	fi
}

# --- shared helpers --------------------------------------------------------

# _forge_extract_url <cli-output> <pattern>
#
# Both CLIs print prose around the URL, and each spells it differently
# (`/pull/N` vs `/merge_requests/N`). Callers get the URL and nothing else.
_forge_extract_url() {
	local url
	url=$(printf '%s\n' "${1-}" | grep -Eo "${2-}" | tail -n 1) || url=
	url=${url//$'\r'/}
	if [ -z "$url" ]; then
		_forge_err "the forge did not print a merge request URL - check the repository by hand"
		return 1
	fi
	printf '%s\n' "$url"
}

# --- the four verbs --------------------------------------------------------

# forge_mr_create --source <branch> --target <branch> --title <text>
#                 [--body <text> | --body-file <path>] [--draft]
#                 [--repo <slug> | --dir <path>]
#
# Prints the merge request URL. That URL is the reference the other three verbs
# take, and the value branching.md §6.4 stores as `unit.mr`.
forge_mr_create() {
	_forge_begin "repo dir source target title body body-file draft" "$@" || return $?
	_forge_need_dir || return $?

	if [ -z "$_forge_source" ] || [ -z "$_forge_target" ]; then
		_forge_err "--source and --target are both required - a merge request always says where it comes from and where it goes"
		return 2
	fi
	if [ -z "$_forge_title" ]; then
		_forge_err "--title is required"
		return 2
	fi
	if [ -n "$_forge_body" ] && [ -n "$_forge_body_file" ]; then
		_forge_err "--body and --body-file are alternatives - pass one"
		return 2
	fi

	local kind
	kind=$(_forge_kind) || return $?
	case $kind in
	github) _forge_github_mr_create ;;
	gitlab) _forge_gitlab_mr_create ;;
	esac
}

# forge_mr_state --mr <url|number> [--repo <slug> | --dir <path>]
#
# Prints exactly one of: merged | closed | open | unknown.
forge_mr_state() {
	_forge_begin "repo dir mr" "$@" || return $?
	_forge_need_mr || return $?
	_forge_need_dir || return $?

	local kind
	kind=$(_forge_kind) || return $?
	case $kind in
	github) _forge_github_mr_state ;;
	gitlab) _forge_gitlab_mr_state ;;
	esac
}

# forge_mr_merge --mr <url|number> [--strategy merge|squash|rebase]
#                [--delete-source] [--repo <slug> | --dir <path>]
#
# Merges now. Prints nothing; exit 0 means it merged.
#
# --delete-source is off by default on purpose: worktree.md §7 fixes the order
# of `yan shift done` as return the tree, THEN delete the remote branch, and a
# forge that deleted it during the merge would take that step away.
forge_mr_merge() {
	_forge_begin "repo dir mr strategy delete-source" "$@" || return $?
	_forge_need_mr || return $?
	_forge_need_dir || return $?

	case $_forge_strategy in
	merge | squash | rebase) ;;
	*)
		_forge_err "unknown merge strategy '$_forge_strategy' - use merge, squash or rebase"
		return 2
		;;
	esac

	local kind
	kind=$(_forge_kind) || return $?
	case $kind in
	github) _forge_github_mr_merge ;;
	gitlab) _forge_gitlab_mr_merge ;;
	esac
}

# forge_ci_state --mr <url|number> [--repo <slug> | --dir <path>]
#
# Prints exactly one of: green | red | pending | none.
#
# It does not say which job failed. That is not withheld to be tidy: the two
# providers' job identities do not line up, and inventing a common shape for
# them would throw information away. `red` is the fact; reading the details is
# the shift's job.
forge_ci_state() {
	_forge_begin "repo dir mr" "$@" || return $?
	_forge_need_mr || return $?
	_forge_need_dir || return $?

	local kind
	kind=$(_forge_kind) || return $?
	case $kind in
	github) _forge_github_ci_state ;;
	gitlab) _forge_gitlab_ci_state ;;
	esac
}
