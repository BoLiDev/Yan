# shellcheck shell=bash
#
# Stand-in for bin/lib-noop.sh. Selected by pointing YAN_LIB at this directory.
# Real stubs (lib-term, lib-forge, lib-pool) arrive with their phases; this one
# only demonstrates the mechanism.

if [ -n "${_YAN_LIB_NOOP_SOURCED:-}" ]; then
	return 0
fi
_YAN_LIB_NOOP_SOURCED=1

noop_which() { printf 'stub\n'; }
