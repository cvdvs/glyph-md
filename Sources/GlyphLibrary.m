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
@property (nonatomic, assign) BOOL pageLoaded;
@property (nonatomic, strong) NSMutableArray<dispatch_block_t> *waiting;
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

// The folder the always-on server was installed for: the first argument after
// the program in its LaunchAgent (Scripts/glyph-server-agent.sh writes it that
// way, symlinks already resolved). Without one, files open as they always did.
+ (NSString *)servedFolder {
    NSString *plist = [NSHomeDirectory() stringByAppendingPathComponent:
                       @"Library/LaunchAgents/com.glyph.server.plist"];
    NSArray *args = [NSDictionary dictionaryWithContentsOfFile:plist][@"ProgramArguments"];
    if (![args isKindOfClass:NSArray.class]) return nil;
    for (NSUInteger i = 1; i < args.count; i++) {
        NSString *a = args[i];
        if (![a isKindOfClass:NSString.class] || [a hasPrefix:@"-"]) continue;
        BOOL dir = NO;
        if ([NSFileManager.defaultManager fileExistsAtPath:a isDirectory:&dir] && dir) return a;
        return nil;
    }
    return nil;
}

+ (NSString *)servedPathForURL:(NSURL *)url {
    if (!url.isFileURL || ![self available]) return nil;
    return [self pathOf:url inFolder:[self servedFolder]];
}

+ (NSString *)pathOf:(NSURL *)url inFolder:(NSString *)folder {
    NSString *root = folder.stringByResolvingSymlinksInPath;
    NSString *path = url.path.stringByResolvingSymlinksInPath;
    if (!root.length || !path.length) return nil;
    // The Mac's disk ignores case, and so does this.
    NSString *prefix = [root hasSuffix:@"/"] ? root : [root stringByAppendingString:@"/"];
    if (path.length <= prefix.length ||
        [path compare:prefix options:NSCaseInsensitiveSearch range:NSMakeRange(0, prefix.length)] != NSOrderedSame) {
        return nil;
    }
    return [path substringFromIndex:prefix.length];
}

// The page decides, since the server is what knows which files it shows (a
// hidden one, or one it skips, it refuses). Five seconds without an answer is a
// server that is not there, and the file must still open somewhere.
- (void)openServedPath:(NSString *)path completion:(void (^)(BOOL opened))done {
    if (!self.window) [self build];
    __block BOOL settled = NO;
    void (^finish)(BOOL) = ^(BOOL opened) {
        if (settled) return;
        settled = YES;
        if (opened) [self show];
        done(opened);
    };
    __weak GlyphLibrary *weakSelf = self;
    dispatch_block_t ask = ^{
        [weakSelf.webView callAsyncJavaScript:@"return window.glyphOpenNote ? await window.glyphOpenNote(path) : false"
                                    arguments:@{@"path": path}
                                      inFrame:nil
                               inContentWorld:WKContentWorld.pageWorld
                            completionHandler:^(id result, NSError *error) {
            finish([result isKindOfClass:NSNumber.class] && [result boolValue]);
        }];
    };
    if (self.pageLoaded) ask();
    else {
        if (!self.waiting) self.waiting = [NSMutableArray array];
        [self.waiting addObject:ask];
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        finish(NO);
    });
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

// Loaded, or failed to: either way a note waiting to open can now be asked
// about, and on a page that never came the answer is a plain no.
- (void)pageSettled {
    self.pageLoaded = YES;
    NSArray<dispatch_block_t> *waiting = self.waiting;
    self.waiting = nil;
    for (dispatch_block_t ask in waiting) ask();
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    [self pageSettled];
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    [self pageSettled];
    NSString *page = @"<!doctype html><meta charset=utf-8><body style='font:15px -apple-system;"
                     @"color:#888;text-align:center;padding-top:30vh;background:transparent'>"
                     @"The Glyph server isn't running on this Mac, so there is nothing to show yet.";
    [webView loadHTMLString:page baseURL:nil];
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    self.pageLoaded = NO;
    [webView loadRequest:[NSURLRequest requestWithURL:[self pageURL]]];
}

@end
