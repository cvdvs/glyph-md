#import "GlyphLibrary.h"
#import <WebKit/WebKit.h>
#import "GlyphPDFDocument.h"
#import "GlyphTheme.h"

// Shown through the server on this Mac, at 127.0.0.1, which a browser counts as
// secure, so dictation can use the microphone here without the https address.
// The page is the server's: it only ever navigates within it, and anything else
// it links to opens in the browser under the same rule as a note's links.
static NSString *GlyphTokenPath(void) {
    return [NSHomeDirectory() stringByAppendingPathComponent:@".config/glyph/server-token"];
}

static NSInteger GlyphServerPort(void) {
    NSInteger port = [NSUserDefaults.standardUserDefaults integerForKey:@"GlyphServerPort"];
    return port > 0 && port < 65536 ? port : 4321;
}

@interface GlyphLibrary () <WKNavigationDelegate, WKUIDelegate, NSWindowDelegate>
@property (nonatomic, strong) NSWindow *window;
@property (nonatomic, strong) WKWebView *webView;
@end

@implementation GlyphLibrary

+ (instancetype)shared {
    static GlyphLibrary *library;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ library = [[GlyphLibrary alloc] init]; });
    return library;
}

+ (BOOL)available {
    return [NSFileManager.defaultManager isReadableFileAtPath:GlyphTokenPath()];
}

- (NSURL *)pageURL {
    NSString *token = [[NSString stringWithContentsOfFile:GlyphTokenPath() encoding:NSUTF8StringEncoding error:NULL]
                       stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    // The token goes in the fragment, which is never sent over the network.
    NSString *s = [NSString stringWithFormat:@"http://127.0.0.1:%ld/?shell=mac#token=%@",
                   (long)GlyphServerPort(), token ?: @""];
    return [NSURL URLWithString:s];
}

- (BOOL)isOurs:(NSURL *)url {
    return [url.scheme isEqualToString:@"http"] && [url.host isEqualToString:@"127.0.0.1"] &&
           url.port.integerValue == GlyphServerPort();
}

- (void)show {
    if (!self.window) [self build];
    [self.window makeKeyAndOrderFront:nil];
}

- (void)build {
    NSWindow *window = [[NSWindow alloc]
        initWithContentRect:NSMakeRect(0, 0, 1200, 780)
                  styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                             NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable |
                             NSWindowStyleMaskFullSizeContentView)
                    backing:NSBackingStoreBuffered
                      defer:NO];
    window.title = @"Notes";
    window.titleVisibility = NSWindowTitleHidden;
    window.titlebarAppearsTransparent = YES;
    window.releasedWhenClosed = NO;
    window.minSize = NSMakeSize(560, 420);
    window.backgroundColor = GlyphBG();
    // Its own window, never a tab among the files opened from Finder.
    window.tabbingMode = NSWindowTabbingModeDisallowed;
    window.delegate = self;
    [window center];
    window.frameAutosaveName = @"GlyphLibrary";

    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    WKWebView *web = [[WKWebView alloc] initWithFrame:window.contentView.bounds configuration:config];
    web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    web.navigationDelegate = self;
    web.UIDelegate = self;
    @try { [web setValue:@NO forKey:@"drawsBackground"]; } @catch (NSException *e) {}
    window.contentView = web;
    self.window = window;
    self.webView = web;
    [web loadRequest:[NSURLRequest requestWithURL:[self pageURL]]];
}

- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)action
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = action.request.URL;
    if ([self isOurs:url] && action.navigationType != WKNavigationTypeLinkActivated && action.targetFrame.isMainFrame) {
        decisionHandler(WKNavigationActionPolicyAllow);
        return;
    }
    if (action.navigationType == WKNavigationTypeLinkActivated) GlyphOpenWebLink(url);
    decisionHandler(WKNavigationActionPolicyCancel);
}

// A link the page opens in a new window (a book's web links) goes to the browser.
- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
   forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)features {
    GlyphOpenWebLink(action.request.URL);
    return nil;
}

// Dictation. Only the server's own page gets the microphone, and macOS still asks
// once whether Glyph may use it.
- (void)webView:(WKWebView *)webView requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin
    initiatedByFrame:(WKFrameInfo *)frame type:(WKMediaCaptureType)type
     decisionHandler:(void (^)(WKPermissionDecision))decisionHandler API_AVAILABLE(macos(12.0)) {
    BOOL ours = [origin.protocol isEqualToString:@"http"] && [origin.host isEqualToString:@"127.0.0.1"] &&
                origin.port == GlyphServerPort() && frame.isMainFrame && type == WKMediaCaptureTypeMicrophone;
    decisionHandler(ours ? WKPermissionDecisionGrant : WKPermissionDecisionDeny);
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    NSString *page = @"<!doctype html><meta charset=utf-8><body style='font:15px -apple-system;"
                     @"color:#888;text-align:center;padding-top:30vh;background:transparent'>"
                     @"The Glyph server isn't running on this Mac, so there is nothing to show yet.";
    [webView loadHTMLString:page baseURL:nil];
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    [webView loadRequest:[NSURLRequest requestWithURL:[self pageURL]]];
}

@end
