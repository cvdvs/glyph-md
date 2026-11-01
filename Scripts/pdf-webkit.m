// Runs Scripts/pdf-smoke.js against the live server in a real WKWebView — the
// engine an iPhone and iPad use. Started by `node Scripts/pdf-smoke.mjs --webkit`,
// which passes the page address in GLYPH_URL so the token is never in a process
// listing, and prints the suite's JSON on stdout.
//
//   clang -fobjc-arc Scripts/pdf-webkit.m -framework Cocoa -framework WebKit -o /tmp/pdf-webkit
//
// WebKit stops drawing a view it believes nobody can see, and PDF.js paces itself
// on animation frames, so in a hidden view every page stays white forever (measured:
// visibilityState "hidden", 0 frames in 3s, render still pending). So this is a real
// app with a real window floating above the others, and it pumps NSApp's own events:
// the window server reports a window as visible through those, and a bare NSRunLoop
// never delivers them.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        const char *url = getenv("GLYPH_URL");
        if (argc < 2 || !url) { fprintf(stderr, "usage: GLYPH_URL=... pdf-webkit <script.js>\n"); return 2; }
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        [NSApp finishLaunching];
        NSString *script = [NSString stringWithContentsOfFile:@(argv[1])
                                                     encoding:NSUTF8StringEncoding error:NULL];
        NSWindow *win = [[NSWindow alloc] initWithContentRect:NSMakeRect(40, 40, 390, 844)
                                                    styleMask:NSWindowStyleMaskTitled
                                                      backing:NSBackingStoreBuffered defer:NO];
        WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
        // What the page finds already saved on the device when it starts.
        if (getenv("GLYPH_SEED")) {
            [config.userContentController addUserScript:
                [[WKUserScript alloc] initWithSource:@(getenv("GLYPH_SEED"))
                                       injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                    forMainFrameOnly:YES]];
        }
        WKWebView *wv = [[WKWebView alloc] initWithFrame:win.contentView.bounds configuration:config];
        [win.contentView addSubview:wv];
        win.level = NSFloatingWindowLevel;
        [win makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
        [wv loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@(url)]]];

        void (^pump)(double) = ^(double secs) {
            NSDate *end = [NSDate dateWithTimeIntervalSinceNow:secs];
            while ([end timeIntervalSinceNow] > 0) {
                NSEvent *ev = [NSApp nextEventMatchingMask:NSEventMaskAny
                                                 untilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]
                                                    inMode:NSDefaultRunLoopMode dequeue:YES];
                if (ev) [NSApp sendEvent:ev];
            }
        };
        pump(2.5);

        __block BOOL done = NO;
        __block int code = 1;
        [wv callAsyncJavaScript:[@"return await " stringByAppendingString:script]
                      arguments:nil inFrame:nil inContentWorld:WKContentWorld.pageWorld
              completionHandler:^(id r, NSError *e) {
            if (e) fprintf(stderr, "pdf-webkit: %s\n", e.localizedDescription.UTF8String);
            else { printf("%s\n", [[NSString stringWithFormat:@"%@", r] UTF8String]); code = 0; }
            done = YES;
        }];
        NSDate *limit = [NSDate dateWithTimeIntervalSinceNow:180];
        while (!done && [limit timeIntervalSinceNow] > 0) pump(0.1);
        if (!done) fprintf(stderr, "pdf-webkit: the suite never finished\n");
        return code;
    }
}
