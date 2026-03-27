// Windowsリリースビルドでコンソールウィンドウを非表示にする
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    app_lib::run()
}
