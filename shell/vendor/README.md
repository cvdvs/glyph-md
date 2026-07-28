# Vendored third-party code

Do not edit anything in here. Refresh with `Scripts/vendor-webview.sh`, which
pins an upstream tag and records the commit in `WEBVIEW-VERSION.txt`.

`webview/webview.h` is [webview/webview](https://github.com/webview/webview),
MIT licensed — one header carrying all three platform backends (WebKitGTK on
Linux, WebView2 on Windows, WKWebView on macOS). It is committed rather than
fetched so a build never depends on the network and an upstream change cannot
reach this project without a deliberate refresh.
