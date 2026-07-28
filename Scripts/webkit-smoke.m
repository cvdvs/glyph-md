// Headless WKWebView smoke test: loads the app's composed viewer template,
// renders sample.md the same way the app does, then simulates a click on a
// paragraph and reports whether the inline block editor appears and commits.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface SmokeDelegate : NSObject <WKNavigationDelegate>
@property (nonatomic, assign) BOOL done;
@property (nonatomic, copy) NSString *mdJSON;
@end

@implementation SmokeDelegate

- (void)webView:(WKWebView *)wv didFinishNavigation:(WKNavigation *)navigation {
    NSString *call = [NSString stringWithFormat:@"window.renderMarkdown(%@[0])", self.mdJSON];
    [wv evaluateJavaScript:call completionHandler:^(id r1, NSError *e1) {
        if (e1) { printf("RENDER-ERR: %s\n", e1.description.UTF8String); self.done = YES; return; }
        NSString *test =
        @"(function(){ try {"
        @"  const md = document.getElementById('md');"
        @"  const r = {editable: md.contentEditable === 'true'};"
        @"  md.focus();"
        @"  const sel = getSelection();"
        @"  const p = md.querySelector('p');"
        @"  const rg = document.createRange(); rg.setStart(p.firstChild, 0); rg.collapse(true);"
        @"  sel.removeAllRanges(); sel.addRange(rg);"
        @"  document.execCommand('insertText', false, 'SMOKE-TYPED ');"
        @"  const ser1 = window.glyphSerialize();"
        @"  r.typed = ser1.includes('SMOKE-TYPED');"
        @"  const np = document.createElement('p'); np.textContent = '## ';"
        @"  md.appendChild(np);"
        @"  const rg2 = document.createRange(); rg2.setStart(np.firstChild, 3); rg2.collapse(true);"
        @"  sel.removeAllRanges(); sel.addRange(rg2);"
        @"  r.blockRule = tryBlockRules();"
        @"  document.execCommand('insertText', false, 'Smoke Heading');"
        @"  const t = document.createRange();"
        @"  t.setStart(p.firstChild, 0); t.setEnd(p.firstChild, 11);"
        @"  sel.removeAllRanges(); sel.addRange(t);"
        @"  window.glyphToolbar('bold');"
        @"  const ser2 = window.glyphSerialize();"
        @"  r.heading = ser2.includes('## Smoke Heading');"
        @"  r.bold = ser2.includes('**SMOKE-TYPED**');"
        @"  r.roundtrip = ser2.includes('> [!important]-') && ser2.includes('| \\u2318E |') && ser2.includes('```css');"
        @"  return JSON.stringify(r);"
        @"} catch (err) { return 'JS-ERR ' + err.message; } })()";
        [wv evaluateJavaScript:test completionHandler:^(id r2, NSError *e2) {
            if (e2) printf("TEST-ERR: %s\n", e2.description.UTF8String);
            else printf("RESULT: %s\n", [[NSString stringWithFormat:@"%@", r2] UTF8String]);
            self.done = YES;
        }];
    }];
}

- (void)webView:(WKWebView *)wv didFailProvisionalNavigation:(WKNavigation *)nav withError:(NSError *)error {
    printf("NAV-ERR: %s\n", error.description.UTF8String);
    self.done = YES;
}

@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        NSString *htmlPath = @(argv[1]);
        NSString *mdPath = @(argv[2]);
        NSString *html = [NSString stringWithContentsOfFile:htmlPath encoding:NSUTF8StringEncoding error:NULL];
        NSString *md = [NSString stringWithContentsOfFile:mdPath encoding:NSUTF8StringEncoding error:NULL];
        if (!html || !md) { printf("MISSING-INPUT\n"); return 1; }
        NSData *j = [NSJSONSerialization dataWithJSONObject:@[md] options:0 error:NULL];

        WKWebViewConfiguration *cfg = [[WKWebViewConfiguration alloc] init];
        WKWebView *wv = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 900, 800) configuration:cfg];
        SmokeDelegate *d = [[SmokeDelegate alloc] init];
        d.mdJSON = [[NSString alloc] initWithData:j encoding:NSUTF8StringEncoding];
        wv.navigationDelegate = d;
        [wv loadHTMLString:html baseURL:nil];

        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:20];
        while (!d.done && [deadline timeIntervalSinceNow] > 0) {
            [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode
                                  beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
        }
        if (!d.done) printf("TIMEOUT\n");
    }
    return 0;
}
