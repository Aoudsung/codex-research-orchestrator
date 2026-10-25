#!/usr/bin/env python3
"""Project-local onboarding; this is not a Python package installer."""
import runpy
import sys
from pathlib import Path

# The forwarded helper checks Python >=3.11 before importing tomllib.
sys.dont_write_bytecode = True
runpy.run_path(str(Path(__file__).parent / "skills/codex-research-orchestrator/scripts/research_setup.py"),
               run_name="__main__")
