from main import build_ffmpeg_cut_command


def test_ffmpeg_cut_command_reads_from_url_with_input_seeking():
    cmd = build_ffmpeg_cut_command("https://cdn/x.mp4", 10, 40, "/tmp/clip.mp4")
    # -ss/-to deben ir ANTES de -i para seeking por rango HTTP eficiente
    assert cmd[:1] == ["ffmpeg"]
    i_ss, i_i = cmd.index("-ss"), cmd.index("-i")
    assert i_ss < i_i
    assert cmd[i_i + 1] == "https://cdn/x.mp4"
    assert "-c" in cmd and cmd[cmd.index("-c") + 1] == "copy"
    assert cmd[-1] == "/tmp/clip.mp4"
