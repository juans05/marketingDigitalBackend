import pytest
from fastapi import HTTPException
from main import build_ffmpeg_cut_command, validate_source_url, build_ffprobe_duration_command


def test_ffprobe_duration_command_targets_the_url():
    cmd = build_ffprobe_duration_command("https://cdn/x.mp4")
    assert cmd[0] == "ffprobe"
    assert cmd[-1] == "https://cdn/x.mp4"
    assert "duration" in " ".join(cmd)


def test_validate_source_url_rechaza_esquemas_no_http():
    with pytest.raises(HTTPException):
        validate_source_url("file:///etc/passwd")


def test_validate_source_url_restringe_al_host_de_r2(monkeypatch):
    monkeypatch.setenv("R2_PUBLIC_URL", "https://cdn.vidalis.com")
    # host distinto al de R2 -> rechazado (anti-SSRF)
    with pytest.raises(HTTPException):
        validate_source_url("https://169.254.169.254/latest/meta-data/")
    # host de R2 que resuelve a IP pública -> aceptado (DNS mockeado para offline)
    monkeypatch.setattr("main.socket.getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("8.8.8.8", 0))])
    assert validate_source_url("https://cdn.vidalis.com/repurposer/sources/a/x.mp4")


def test_validate_source_url_falla_cerrado_sin_r2_public_url(monkeypatch):
    monkeypatch.delenv("R2_PUBLIC_URL", raising=False)
    with pytest.raises(HTTPException):
        validate_source_url("https://cualquier-host.com/x.mp4")


def test_validate_source_url_rechaza_host_que_resuelve_a_ip_privada(monkeypatch):
    monkeypatch.setenv("R2_PUBLIC_URL", "https://cdn.vidalis.com")
    monkeypatch.setattr("main.socket.getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("10.0.0.5", 0))])
    with pytest.raises(HTTPException):
        validate_source_url("https://cdn.vidalis.com/x.mp4")


def test_ffmpeg_cut_command_reads_from_url_with_input_seeking():
    cmd = build_ffmpeg_cut_command("https://cdn/x.mp4", 10, 40, "/tmp/clip.mp4")
    # -ss/-to deben ir ANTES de -i para seeking por rango HTTP eficiente
    assert cmd[:1] == ["ffmpeg"]
    i_ss, i_i = cmd.index("-ss"), cmd.index("-i")
    assert i_ss < i_i
    assert cmd[i_i + 1] == "https://cdn/x.mp4"
    assert "-c" in cmd and cmd[cmd.index("-c") + 1] == "copy"
    assert cmd[-1] == "/tmp/clip.mp4"
