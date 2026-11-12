// Release ビルドで余計なコンソールを出さない（Windows 向けの定型。macOS では影響なし）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cuenu_desktop_lib::run()
}
