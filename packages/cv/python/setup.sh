#!/usr/bin/env bash
# One-time python env for the CV package (teacher, student server, training).
set -e
cd "$(dirname "$0")"
PY=$(command -v python3.12 || command -v python3.11 || command -v python3)
echo "using $PY"
$PY -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt
echo "cv python env ready: $(pwd)/venv"
