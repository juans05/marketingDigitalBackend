import pytest
from fastapi import HTTPException
from main import build_ffmpeg_cut_command, validate_source_url


def test_validate_source_url_rechaza_esquemas_no_http():
    with pytest.raises(HTTPException):
        validate_source_url("file:///etc/passwd")


def test_validate_source_url_restringe_al_host_de_r2(monkeypatch):
    monkeypatch.setenv("R2_PUBLIC_URL", "https://cdn.vidalis.com")
    # host distinto al de R2 -> rechazado (anti-SSRF)
    with pytest.raises(HTTPException):
        validate_source_url("https://169.254.169.254/latest/meta-data/")
    # host de R2 -> aceptado
    assert validate_source_url("https://cdn.vidalis.com/repurposer/sources/a/x.mp4")


def test_ffmpeg_cut_command_reads_from_url_with_input_seeking():
    cmd = build_ffmpeg_cut_command("https://cdn/x.mp4", 10, 40, "/tmp/clip.mp4")
    # -ss/-to deben ir ANTES de -i para seeking por rango HTTP eficiente
    assert cmd[:1] == ["ffmpeg"]
    i_ss, i_i = cmd.index("-ss"), cmd.index("-i")
    assert i_ss < i_i
    assert cmd[i_i + 1] == "https://cdn/x.mp4"
    assert "-c" in cmd and cmd[cmd.index("-c") + 1] == "copy"
    assert cmd[-1] == "/tmp/clip.mp4"
