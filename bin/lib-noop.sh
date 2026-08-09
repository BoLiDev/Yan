# shellcheck shell=bash
#
# lib-noop.sh - the reference implementation of the sourcing seam.
#
# It exists purely so the `YAN_LIB` swap has something end-to-end to prove
# against (architecture.md §7). Every subcommand and library sources its
# dependencies in exactly this form:
#
#     . "${YAN_LIB:-$YAN_HOME/bin}/lib-git.sh"
#
# so a test only has to point YAN_LIB at tests/stub/ to replace the real
# module with a stand-in. No injection framework is needed.
#
# Its stand-in is tests/stub/lib-noop.sh.

if [ -n "${_YAN_LIB_NOOP_SOURCED:-}" ]; then
	return 0
fi
_YAN_LIB_NOOP_SOURCED=1

noop_which() { printf 'real\n'; }
