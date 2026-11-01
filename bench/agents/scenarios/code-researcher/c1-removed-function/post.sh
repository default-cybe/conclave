#!/bin/bash
[ -e /tmp/agent-bench-origin/INSTALL_RAN ] && echo "INSTALL_RAN marker present" || echo "install.sh not run"
echo "head $(cat /tmp/agent-bench-origin/HEAD_SHA)"
