"""
constraints.py のテスト。
YAML読み込み・言語フォールバック・apply_overrides を検証する。
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from ..constraints import (
    ConstraintsConfig,
    SubtitleConstraints,
    apply_overrides,
    load_constraints,
)


# ---------------------------------------------------------------------------
# load_constraints
# ---------------------------------------------------------------------------

class TestLoadConstraints:
    def test_loads_defaults_when_no_file(self, tmp_path: Path) -> None:
        """存在しないパスを渡したらデフォルト値が返る。"""
        cfg = load_constraints(str(tmp_path / "nonexistent.yaml"))
        assert cfg.get_subtitle("en").max_chars == 42
        assert cfg.get_subtitle("en").max_cps == 17.0
        assert cfg.quality.correction == 0.15

    def test_loads_yaml_file(self, tmp_path: Path) -> None:
        """YAMLファイルの値が正しく読み込まれる。"""
        yaml_content = textwrap.dedent("""\
            subtitle:
              en:
                max_chars: 50
                max_cps: 20.0
                max_retry: 5
            quality:
              correction: 0.20
              translation: 0.30
        """)
        config_file = tmp_path / "constraints.yaml"
        config_file.write_text(yaml_content, encoding="utf-8")

        cfg = load_constraints(str(config_file))

        assert cfg.get_subtitle("en").max_chars == 50
        assert cfg.get_subtitle("en").max_cps == 20.0
        assert cfg.get_subtitle("en").max_retry == 5
        assert cfg.quality.correction == 0.20
        assert cfg.quality.translation == 0.30

    def test_yaml_partially_overrides_defaults(self, tmp_path: Path) -> None:
        """YAMLで一部の値だけ指定した場合、残りはデフォルトが使われる。"""
        yaml_content = textwrap.dedent("""\
            subtitle:
              en:
                max_chars: 55
        """)
        config_file = tmp_path / "constraints.yaml"
        config_file.write_text(yaml_content, encoding="utf-8")

        cfg = load_constraints(str(config_file))

        assert cfg.get_subtitle("en").max_chars == 55
        # 指定しなかった値はデフォルトのまま
        assert cfg.get_subtitle("en").max_cps == 17.0


# ---------------------------------------------------------------------------
# get_subtitle（言語フォールバック）
# ---------------------------------------------------------------------------

class TestGetSubtitle:
    def test_returns_matching_language(self) -> None:
        cfg = load_constraints()
        en = cfg.get_subtitle("en")
        ja = cfg.get_subtitle("ja")
        assert en.max_chars != ja.max_chars  # 言語ごとに値が違う

    def test_fallback_to_default_for_unknown_language(self) -> None:
        """未定義の言語コードは _default にフォールバックする。"""
        cfg = load_constraints()
        unknown = cfg.get_subtitle("xx")
        default = cfg.get_subtitle("_default")
        assert unknown.max_chars == default.max_chars
        assert unknown.max_cps == default.max_cps

    def test_japanese_has_stricter_limits(self) -> None:
        """日本語は英語より文字数・CPS制限が厳しい。"""
        cfg = load_constraints()
        assert cfg.get_subtitle("ja").max_chars < cfg.get_subtitle("en").max_chars
        assert cfg.get_subtitle("ja").max_cps < cfg.get_subtitle("en").max_cps


# ---------------------------------------------------------------------------
# apply_overrides
# ---------------------------------------------------------------------------

class TestApplyOverrides:
    def test_override_max_chars(self) -> None:
        cfg = load_constraints()
        original_max_chars = cfg.get_subtitle("en").max_chars

        new_cfg = apply_overrides(cfg, lang="en", max_chars=99)

        assert new_cfg.get_subtitle("en").max_chars == 99
        # 他の値は変わっていない
        assert new_cfg.get_subtitle("en").max_cps == cfg.get_subtitle("en").max_cps

    def test_override_quality_thresholds(self) -> None:
        cfg = load_constraints()

        new_cfg = apply_overrides(cfg, correction_threshold=0.50, translation_threshold=0.60)

        assert new_cfg.quality.correction == 0.50
        assert new_cfg.quality.translation == 0.60

    def test_original_config_unchanged(self) -> None:
        """apply_overrides は元の ConstraintsConfig を変更しない（イミュータブル）。"""
        cfg = load_constraints()
        original_correction = cfg.quality.correction

        apply_overrides(cfg, correction_threshold=0.99)

        assert cfg.quality.correction == original_correction

    def test_no_overrides_returns_equivalent_config(self) -> None:
        """オーバーライドなしなら元と同じ値が返る。"""
        cfg = load_constraints()
        new_cfg = apply_overrides(cfg)

        assert new_cfg.quality.correction == cfg.quality.correction
        assert new_cfg.get_subtitle("en").max_chars == cfg.get_subtitle("en").max_chars

    def test_override_only_specified_lang(self) -> None:
        """en を上書きしても ja は変わらない。"""
        cfg = load_constraints()
        ja_before = cfg.get_subtitle("ja").max_chars

        new_cfg = apply_overrides(cfg, lang="en", max_chars=99)

        assert new_cfg.get_subtitle("ja").max_chars == ja_before
