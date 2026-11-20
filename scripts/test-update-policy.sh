#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
compiler=${SWIFTC:-swiftc}
"$compiler" -swift-version 5 -parse-as-library \
  "$root/packages/desktop-macos/Sources/AITurnMeterCore/UpdatePolicy.swift" \
  "$root/tests/swift/UpdatePolicyTests.swift" -o "$work/update-policy-tests"
"$work/update-policy-tests"
