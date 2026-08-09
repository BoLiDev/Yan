#!/usr/bin/env bash
#
# yan doctor - print the dependency checklist and exit non-zero if a hard
# dependency is missing or misconfigured.
#
set -euo pipefail

: "${YAN_HOME:?yan-doctor: YAN_HOME is not set - run this through bin/yan}"

# shellcheck source=bin/lib-boot.sh
. "${YAN_LIB:-$YAN_HOME/bin}/lib-boot.sh"

boot_doctor
