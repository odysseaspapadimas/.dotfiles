#!/usr/bin/env python3
"""Minimal tests for the numbered-tabs label policy."""

import importlib.util
from pathlib import Path

MODULE = Path(__file__).parents[1] / ".config/herdr/plugins-local/numbered-tabs/numbered_tabs.py"
spec = importlib.util.spec_from_file_location("numbered_tabs", MODULE)
numbered_tabs = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(numbered_tabs)


def test_labels() -> None:
    assert numbered_tabs.semantic_label("3 · Build feature") == "Build feature"
    assert numbered_tabs.semantic_label("Build feature") == "Build feature"
    assert numbered_tabs.numbered_label(2, "3 · Build feature") == "2 · Build feature"
    assert numbered_tabs.numbered_label(1, "1 · Build feature") == "1 · Build feature"
    assert numbered_tabs.numbered_label(4, "") == "4"
    assert numbered_tabs.numbered_label(4, "3") == "4"
    assert numbered_tabs.numbered_label(4, "3 · 3") == "4"
    assert numbered_tabs.numbered_label(1, "4") == "1"
    assert numbered_tabs.numbered_label(2, "4 · Build feature") == "2 · Build feature"


if __name__ == "__main__":
    test_labels()
    print("numbered-tabs tests passed")
