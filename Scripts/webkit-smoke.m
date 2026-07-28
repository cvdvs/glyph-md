// Runs Scripts/smoke.js against macOS WKWebView — the engine the shipping Mac app
// uses — so the same assertions cover every platform.
//
//   clang -fobjc-arc Scripts/webkit-smoke.m -o /tmp/webkit-smoke -framework Cocoa -framework WebKit
//   /tmp/webkit-smoke <composed.html> <document.md> <Scripts/smoke.js> [result.json]
//
// Prints the result JSON and exits nonzero if any assertion is false, so CI can
// gate on it. The optional 4th argument writes the raw JSON to a file, which is
// how the cross-engine comparison gets the serialized markdown out.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface SmokeDelegate : NSObject <WKNavigationDelegate>
@property (nonatomic, assign) BOOL done;
@property (nonatomic, assign) BOOL failed;
@property (nonatomic, copy) NSString *mdJSON;
@property (nonatomic, copy) NSString *smokeJS;
@property (nonatomic, copy) NSString *outPath;
@end

@implementation SmokeDelegate

- (void)webView:(WKWebView *)wv didFinishNavigation:(WKNavigation *)navigation {
    NSString *call = [NSString stringWithFormat:@"window.renderMarkdown(%@[0])", self.mdJSON];
    [wv evaluateJavaScript:call completionHandler:^(id r1, NSError *e1) {
        if (e1) {
            printf("RENDER-ERROR: %s\n", e1.localizedDescription.UTF8String);
            self.failed = YES;
            self.done = YES;
            return;
        }
        [wv evaluateJavaScript:self.smokeJS completionHandler:^(id r2, NSError *e2) {
            if (e2) {
                printf("SMOKE-ERROR: %s\n", e2.localizedDescription.UTF8String);
                self.failed = YES;
                self.done = YES;
                return;
            }
            NSString *json = [NSString stringWithFormat:@"%@", r2];
            if (self.outPath) {
                [json writeToFile:self.outPath atomically:YES
                         encoding:NSUTF8StringEncoding error:NULL];
            }

            NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
            NSDictionary *d = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
            NSMutableArray *bad = [NSMutableArray array];
            NSMutableDictionary *shown = [NSMutableDictionary dictionary];
            for (NSString *k in d) {
                if ([k isEqualToString:@"serialized"]) continue;
                id v = d[k];
                shown[k] = v;
                if ([k hasSuffix:@"Error"]) { [bad addObject:k]; continue; }
                if ([v isKindOfClass:[NSNumber class]]) {
                    if (strcmp([v objCType], @encode(char)) == 0) {
                        if (![v boolValue]) [bad addObject:k];
                    } else if ([v doubleValue] <= 0) {
                        [bad addObject:k];
                    }
                }
            }
            NSData *pretty = [NSJSONSerialization dataWithJSONObject:shown options:0 error:NULL];
            printf("webkit-smoke (WKWebView):\n  %s\n",
                   [[NSString alloc] initWithData:pretty encoding:NSUTF8StringEncoding].UTF8String);
            if (bad.count) {
                printf("\nFAILED assertions: %s\n",
                       [bad componentsJoinedByString:@", "].UTF8String);
                self.failed = YES;
            } else {
                printf("  ALL PASS\n");
            }
            self.done = YES;
        }];
    }];
}

- (void)webView:(WKWebView *)wv didFailProvisionalNavigation:(WKNavigation *)nav withError:(NSError *)error {
    printf("NAV-ERROR: %s\n", error.localizedDescription.UTF8String);
    self.failed = YES;
    self.done = YES;
}

@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc < 4) {
            fprintf(stderr, "usage: webkit-smoke <composed.html> <document.md> <smoke.js> [result.json]\n");
            return 2;
        }
        [NSApplication sharedApplication];
        NSString *html = [NSString stringWithContentsOfFile:@(argv[1]) encoding:NSUTF8StringEncoding error:NULL];
        NSString *md = [NSString stringWithContentsOfFile:@(argv[2]) encoding:NSUTF8StringEncoding error:NULL];
        NSString *smoke = [NSString stringWithContentsOfFile:@(argv[3]) encoding:NSUTF8StringEncoding error:NULL];
        if (!html || !md || !smoke) {
            fprintf(stderr, "webkit-smoke: could not read inputs\n");
            return 2;
        }
        NSData *j = [NSJSONSerialization dataWithJSONObject:@[md] options:0 error:NULL];

        WKWebViewConfiguration *cfg = [[WKWebViewConfiguration alloc] init];
        WKWebView *wv = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 1000, 1400)
                                           configuration:cfg];
        SmokeDelegate *d = [[SmokeDelegate alloc] init];
        d.mdJSON = [[NSString alloc] initWithData:j encoding:NSUTF8StringEncoding];
        d.smokeJS = smoke;
        d.outPath = argc > 4 ? @(argv[4]) : nil;
        wv.navigationDelegate = d;
        // Base URL is the document's folder so relative image paths resolve the
        // same way they do in the real app.
        NSURL *base = [[NSURL fileURLWithPath:@(argv[2])] URLByDeletingLastPathComponent];
        [wv loadHTMLString:html baseURL:base];

        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:25];
        while (!d.done && [deadline timeIntervalSinceNow] > 0) {
            [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode
                                  beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
        }
        if (!d.done) {
            printf("TIMEOUT\n");
            return 1;
        }
        return d.failed ? 1 : 0;
    }
    return 0;
}
