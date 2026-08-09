# shellcheck shell=bash
#
# lib-json.sh - read and write JSON (architecture.md §4.1).
#
# Stateless. Depends on nothing but jq.
#
# Invariants it enforces (td INDEX.md §2):
#   1. every write goes through a temporary file in the SAME directory as the
#      target and is then mv'd into place, so the rename stays inside one
#      filesystem and a reader never sees a half-written file;
#   2. every object written carries a `version` field - the one hook left for
#      a future schema migration;
#   3. invalid JSON is refused before the target is touched, so a failed write
#      always leaves the previous content intact.

if [ -n "${_YAN_LIB_JSON_SOURCED:-}" ]; then
	return 0
fi
_YAN_LIB_JSON_SOURCED=1

_json_err() {
	printf 'lib-json: %s\n' "$1" >&2
}

# _json_lf - strip the CR from CRLF line endings.
#
# jq.exe on Git Bash emits CRLF:
#
#   $ printf '{"a":"1","b":"2"}' | jq -r 'to_entries[]|.key' | od -c
#   0000000   a  \r  \n   b  \r  \n
#
# This is worse than it looks. `$(...)` strips a *trailing* newline, so a
# single-value read looks perfectly fine and hides the problem entirely; only
# MULTI-LINE output is corrupted, and then every line but the last carries a
# trailing CR. A comparison against a literal then fails for no visible reason,
# on one platform only. Every jq pass in this library goes through here.
#
# Only a trailing CR is removed, never one in the middle of a line: jq escapes
# real control characters inside JSON strings as \r (two characters), so a raw
# CR byte at end of line is always the line-ending artefact and never data.
_json_lf() {
	sed $'s/\r$//'
}

# _json_atomic_write <file> <json-string>
#
# The only place in the code base that replaces a JSON file.
_json_atomic_write() {
	local file=${1:-} json=${2-}

	if [ -z "$file" ]; then
		_json_err "a target file is required"
		return 2
	fi
	if [ -z "$json" ]; then
		_json_err "refusing to write empty content to $file"
		return 1
	fi

	local dir tmp
	dir=$(dirname -- "$file")
	if ! mkdir -p -- "$dir"; then
		_json_err "cannot create directory: $dir"
		return 1
	fi

	# The template is anchored to the target's own directory on purpose:
	# mktemp would otherwise honour $TMPDIR and the mv could cross a
	# filesystem boundary, which is a copy, which is not atomic.
	if ! tmp=$(mktemp "$dir/.yan-json.XXXXXX"); then
		_json_err "cannot create a temporary file in $dir"
		return 1
	fi

	# One jq pass both validates the input and guarantees the version field.
	# jq must stay the last command in this pipeline-free form: piping it
	# straight into _json_lf would hand us the exit status of sed instead, and
	# an invalid-JSON write would then look like a success.
	if ! printf '%s' "$json" | jq '
			if type == "object" and (has("version") | not)
			then . + {version: 1}
			else . end
		' >"$tmp" 2>/dev/null; then
		rm -f -- "$tmp"
		_json_err "refusing to write invalid JSON to $file"
		return 1
	fi

	# Normalise separately, so the file is LF on both platforms and a JSON file
	# written on Windows is byte-identical to one written on Linux.
	if _json_lf <"$tmp" >"$tmp.lf" 2>/dev/null; then
		mv -f -- "$tmp.lf" "$tmp"
	else
		rm -f -- "$tmp.lf"
	fi

	# Belt and braces: never mv anything jq cannot read back, and never mv an
	# empty file (jq accepts empty input and produces nothing).
	if [ ! -s "$tmp" ] || ! jq empty "$tmp" >/dev/null 2>&1; then
		rm -f -- "$tmp"
		_json_err "refusing to write invalid JSON to $file"
		return 1
	fi

	if [ -f "$file" ]; then
		chmod --reference="$file" -- "$tmp" 2>/dev/null || chmod 644 -- "$tmp"
	else
		chmod 644 -- "$tmp"
	fi

	if ! mv -f -- "$tmp" "$file"; then
		rm -f -- "$tmp"
		_json_err "cannot replace $file"
		return 1
	fi
}

# json_read <file> <jq-filter>
#
# Prints the raw (jq -r) value. Non-zero when the file is missing or the
# filter fails.
json_read() {
	local file=${1:-} filter=${2:-}
	if [ -z "$file" ] || [ -z "$filter" ]; then
		_json_err "usage: json_read <file> <jq-filter>"
		return 2
	fi
	if [ ! -f "$file" ]; then
		_json_err "no such file: $file"
		return 1
	fi
	jq -r "$filter" "$file" | _json_lf
	return "${PIPESTATUS[0]}"
}

# json_write <file> <json-string>
json_write() {
	if [ $# -lt 2 ]; then
		_json_err "usage: json_write <file> <json-string>"
		return 2
	fi
	_json_atomic_write "$1" "$2"
}

# json_edit <file> <jq-program> [jq-args...]
#
# Read-modify-write through the same atomic path. The file's existing
# `version` is carried over unless the program set one itself.
json_edit() {
	local file=${1:-} prog=${2:-}
	if [ -z "$file" ] || [ -z "$prog" ]; then
		_json_err "usage: json_edit <file> <jq-program> [jq-args...]"
		return 2
	fi
	if [ ! -f "$file" ]; then
		_json_err "no such file: $file"
		return 1
	fi
	shift 2

	local out ver
	if ! out=$(jq "$@" "$prog" "$file"); then
		_json_err "jq program failed; $file left untouched"
		return 1
	fi

	ver=$(jq -c 'if type == "object" and has("version") then .version else empty end' "$file" 2>/dev/null) || ver=
	if [ -n "$ver" ]; then
		if ! out=$(printf '%s' "$out" | jq --argjson v "$ver" '
				if type == "object" and (has("version") | not)
				then . + {version: $v}
				else . end
			'); then
			_json_err "cannot preserve the version field of $file"
			return 1
		fi
	fi

	_json_atomic_write "$file" "$out"
}

# json_init <file> <json-string>
#
# Creates the file only when it is absent. Existing content is never touched.
json_init() {
	if [ $# -lt 2 ]; then
		_json_err "usage: json_init <file> <json-string>"
		return 2
	fi
	if [ -e "$1" ]; then
		return 0
	fi
	_json_atomic_write "$1" "$2"
}
