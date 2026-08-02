// Proves Select All and Copy-as-Markdown work in the macOS FORMATTED view,
// against the app's own GlyphWebView — not a stand-in.
//
//   clang -fobjc-arc Scripts/selectall-smoke.m Sources/MarkdownDocument.m \
//     Sources/GlyphTheme.m Sources/GlyphHighlighter.m Sources/GlyphGutter.m \
//     Sources/GlyphVault.m -framework Cocoa -framework WebKit \
//     -framework UniformTypeIdentifiers -o /tmp/selectall-smoke
//   /tmp/selectall-smoke <composed.html> <document.md>
//
// WHY THIS EXISTS. Select All was dead in the formatted view and nothing caught
// it, because every other suite talks to the page and the page was fine. The
// failure lived in the seam: WebKit's own selectAll: selects NOTHING while the
// page's activeElement is BODY, and that is exactly the state -applyMode leaves
// behind — making the web view first responder does not focus anything inside
// the page. Measured on sample.md: 0 characters selected with BODY focused,
// 1327 with the article focused. GlyphWebView -selectAll: now calls into the
// page instead, and this asserts that from the AppKit side, which is the only
// side that can see the bug.
//
// GlyphWebView is file-private to MarkdownDocument.m on purpose; the class is
// still registered with the runtime, so the test reaches it by name rather than
// by widening the header for a test's convenience.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

static WKWebView *gWV;
static BOOL gLoaded = NO;
static int gFails = 0;

@interface Nav : NSObject <WKNavigationDelegate>
@end
@implementation Nav
- (void)webView:(WKWebView *)wv didFinishNavigation:(WKNavigation *)n { gLoaded = YES; }
- (void)webView:(WKWebView *)wv didFailProvisionalNavigation:(WKNavigation *)n withError:(NSError *)e {
    printf("NAV-ERROR: %s\n", e.localizedDescription.UTF8String);
    exit(1);
}
@end

static void pump(double secs, BOOL (^cond)(void)) {
    NSDate *end = [NSDate dateWithTimeIntervalSinceNow:secs];
    while ([end timeIntervalSinceNow] > 0) {
        if (cond && cond()) return;
        [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode
                              beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
    }
}

static NSString *js(NSString *src) {
    __block NSString *out = nil;
    __block BOOL done = NO;
    [gWV evaluateJavaScript:src completionHandler:^(id r, NSError *e) {
        out = e ? nil : [NSString stringWithFormat:@"%@", r];
        done = YES;
    }];
    pump(5, ^BOOL{ return done; });
    return out ?: @"";
}

static void check(const char *name, BOOL ok, NSString *detail) {
    printf("  %-38s %s%s%s\n", name, ok ? "pass" : "FAIL",
           detail.length ? "   " : "", detail.length ? detail.UTF8String : "");
    if (!ok) gFails++;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc < 3) {
            fprintf(stderr, "usage: selectall-smoke <composed.html> <doc.md>\n");
            return 2;
        }
        [NSApplication sharedApplication];
        NSString *html = [NSString stringWithContentsOfFile:@(argv[1])
                                                   encoding:NSUTF8StringEncoding error:NULL];
        NSString *md = [NSString stringWithContentsOfFile:@(argv[2])
                                                 encoding:NSUTF8StringEncoding error:NULL];
        if (!html || !md) { fprintf(stderr, "selectall-smoke: could not read inputs\n"); return 2; }
        NSString *mdJSON = [[NSString alloc]
            initWithData:[NSJSONSerialization dataWithJSONObject:@[md] options:0 error:NULL]
                encoding:NSUTF8StringEncoding];

        Class cls = NSClassFromString(@"GlyphWebView");
        if (!cls) { printf("GlyphWebView is not registered — link MarkdownDocument.m\n"); return 1; }

        NSWindow *win = [[NSWindow alloc]
            initWithContentRect:NSMakeRect(0, 0, 1000, 900)
                      styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        gWV = [[cls alloc] initWithFrame:win.contentView.bounds
                           configuration:[[WKWebViewConfiguration alloc] init]];
        [win.contentView addSubview:gWV];
        Nav *nav = [[Nav alloc] init];
        gWV.navigationDelegate = nav;
        NSURL *base = [[NSURL fileURLWithPath:@(argv[2])] URLByDeletingLastPathComponent];
        [gWV loadHTMLString:html baseURL:base];
        // Deliberately NOT ordered front and never activated. CI runs this
        // headless, and a test that needs to become the active app is a test
        // that fails on a runner for reasons unrelated to the thing it checks.
        // Nothing here needs it: the override is invoked directly, the way the
        // Edit menu invokes it, and it still selects 1327 of 1371 characters
        // with the window offscreen (checked both ways).
        pump(20, ^BOOL{ return gLoaded; });
        if (!gLoaded) { printf("page never loaded\n"); return 1; }

        js([NSString stringWithFormat:@"window.renderMarkdown(%@[0])", mdJSON]);
        // Exactly what -applyMode does on leaving the raw view. This is the
        // state the bug lived in, so the test has to start from it.
        [win makeFirstResponder:gWV];
        pump(0.4, nil);

        printf("selectall-smoke (macOS GlyphWebView):\n");

        NSString *focusBefore = js(@"(document.activeElement && document.activeElement.id) "
                                    "|| document.activeElement.tagName");
        check("starts with nothing focused", [focusBefore isEqualToString:@"BODY"], focusBefore);

        NSInteger docLen = [js(@"String(document.getElementById('md').innerText.length)") integerValue];
        check("document has text", docLen > 100, [NSString stringWithFormat:@"%ld chars", (long)docLen]);

        // The whole point: the app's own override, invoked the way the Edit
        // menu invokes it.
        [gWV selectAll:nil];
        pump(0.8, nil);
        NSInteger selLen = [js(@"String(getSelection().toString().length)") integerValue];
        check("selectAll: selects the note", selLen > 0,
              [NSString stringWithFormat:@"%ld chars", (long)selLen]);
        // Not a token selection of one node — it has to reach the end.
        check("selection covers the document", selLen > docLen * 0.8,
              [NSString stringWithFormat:@"%ld of %ld", (long)selLen, (long)docLen]);

        // Menu validation: AppKit greys the item out when nothing validates it,
        // and WKWebView refuses selectAll: in exactly the state above.
        NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:@"Select All"
                                                      action:@selector(selectAll:)
                                               keyEquivalent:@"a"];
        check("Select All validates as enabled",
              [(id<NSUserInterfaceValidations>)gWV validateUserInterfaceItem:item], @"");

        // And what a copy would put on the clipboard is MARKDOWN, not the
        // rendered text. Read through the page, so the pasteboard — which
        // belongs to whoever is running this — is left alone.
        NSString *all = js(@"window.glyphCopyText('all')");
        check("copy 'all' keeps heading syntax", [all containsString:@"#"], @"");
        check("copy 'all' is the whole note", all.length > (NSUInteger)(docLen * 0.5),
              [NSString stringWithFormat:@"%lu chars", (unsigned long)all.length]);
        check("copy 'all' leaks no HTML tags",
              ![all containsString:@"<article"] && ![all containsString:@"<p>"], @"");

        printf(gFails ? "\nFAILED: %d\n" : "\n  ALL PASS\n", gFails);
        return gFails ? 1 : 0;
    }
}
