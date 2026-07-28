// Round-trip fidelity over a corpus of real documents. Renders each one the way
// Glyph does, serializes it back, and reports whether the author's words survive
// — the same rule the app's autosave guard uses, so this measures the shipping
// behavior rather than an approximation of it.
//
// Build:
//   clang -fobjc-arc Scripts/roundtrip.m -o /tmp/roundtrip -framework Cocoa -framework WebKit
//
// Original header:
// Round-trip fidelity over a real corpus: render each document the way Glyph
// does, serialize it back, and report whether any of the author's CONTENT was
// lost. Normalization (bullet style, spacing) is expected and not counted; a
// missing line of prose is the thing that matters.
//
//   roundtrip <template.html> <filelist.txt> <out.jsonl>
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

static NSCountedSet *WordBag(NSString *text) {
    NSCountedSet *bag = [NSCountedSet set];
    if (!text.length) return bag;
    static NSRegularExpression *entity;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        entity = [NSRegularExpression regularExpressionWithPattern:@"&(#[0-9a-fA-F]+|[a-zA-Z]+);"
                                                           options:0 error:NULL];
    });
    NSString *flat = [entity stringByReplacingMatchesInString:text options:0
                                                        range:NSMakeRange(0, text.length)
                                                 withTemplate:@" "];
    NSCharacterSet *w = [NSCharacterSet alphanumericCharacterSet];
    NSScanner *sc = [NSScanner scannerWithString:flat.lowercaseString];
    sc.charactersToBeSkipped = w.invertedSet;
    NSString *tok = nil;
    while ([sc scanCharactersFromSet:w intoString:&tok]) if (tok.length >= 3) [bag addObject:tok];
    return bag;
}

static BOOL Preserves(NSString *a, NSString *b, NSMutableArray *lostOut) {
    NSCountedSet *before = WordBag(a), *after = WordBag(b);
    BOOL ok = YES;
    for (NSString *w in before) {
        if ([after countForObject:w] < [before countForObject:w]) {
            ok = NO;
            if (lostOut.count < 5) [lostOut addObject:w];
        }
    }
    return ok;
}

@interface Runner : NSObject <WKNavigationDelegate>
@property (nonatomic, strong) WKWebView *wv;
@property (nonatomic, strong) NSArray<NSString *> *paths;
@property (nonatomic, assign) NSUInteger index;
@property (nonatomic, assign) BOOL ready;
@property (nonatomic, assign) BOOL finished;
@property (nonatomic, strong) NSFileHandle *out;
@property (nonatomic, assign) NSUInteger lost;
@property (nonatomic, assign) NSUInteger checked;
@property (nonatomic, assign) NSUInteger failed;
@end

@implementation Runner

- (void)webView:(WKWebView *)wv didFinishNavigation:(WKNavigation *)n {
    self.ready = YES;
    [self step];
}

- (void)step {
    if (self.index >= self.paths.count) { self.finished = YES; return; }
    NSString *path = self.paths[self.index++];
    NSString *doc = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL];
    if (!doc || doc.length == 0) { [self step]; return; }
    // Very large files are excluded only to keep this sweep bounded in time.
    if (doc.length > 400000) { [self step]; return; }

    NSData *j = [NSJSONSerialization dataWithJSONObject:@[doc] options:0 error:NULL];
    NSString *arr = [[NSString alloc] initWithData:j encoding:NSUTF8StringEncoding];
    NSString *js = [NSString stringWithFormat:
        @"(function(){ try { window.renderMarkdown(%@[0]); return window.glyphGetText(); }"
        @" catch(e) { return 'GLYPH-ERROR: ' + e; } })()", arr];

    __weak Runner *weakSelf = self;
    [self.wv evaluateJavaScript:js completionHandler:^(id result, NSError *err) {
        Runner *self2 = weakSelf;
        NSString *ser = [result isKindOfClass:[NSString class]] ? result : nil;
        NSMutableDictionary *row = [NSMutableDictionary dictionary];
        row[@"path"] = path.lastPathComponent;
        row[@"origLen"] = @(doc.length);

        if (err || !ser || [ser hasPrefix:@"GLYPH-ERROR"]) {
            self2.failed++;
            row[@"status"] = @"error";
            row[@"detail"] = err ? err.localizedDescription : (ser ?: @"nil");
        } else {
            self2.checked++;
            row[@"serLen"] = @(ser.length);
            // Content loss = a substantial line of the author's text that has no
            // trace in the output. Whitespace and marker normalization ignored.
            NSMutableArray *missing = [NSMutableArray array];
            for (NSString *raw in [doc componentsSeparatedByString:@"\n"]) {
                NSString *line = [raw stringByTrimmingCharactersInSet:
                                  NSCharacterSet.whitespaceCharacterSet];
                if (line.length < 25) continue;
                if ([line hasPrefix:@"|"] || [line hasPrefix:@"<"]) continue;
                // Compare on a distinctive interior slice, immune to marker changes.
                NSUInteger start = MIN((NSUInteger)8, line.length - 20);
                NSString *probe = [line substringWithRange:NSMakeRange(start, 18)];
                if ([ser rangeOfString:probe].location == NSNotFound) {
                    if (missing.count < 3) [missing addObject:probe];
                }
            }
            NSMutableArray *lost = [NSMutableArray array];
            BOOL safe = Preserves(doc, ser, lost);
            row[@"guard"] = safe ? @"editable" : @"PROTECTED";
            if (!safe) { self2.lost++; row[@"lostWords"] = lost; }
            row[@"status"] = safe ? @"ok" : @"CONTENT-LOSS";
        }
        NSData *line = [NSJSONSerialization dataWithJSONObject:row options:0 error:NULL];
        [self2.out writeData:line];
        [self2.out writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
        [self2 step];
    }];
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        NSString *tpl = [NSString stringWithContentsOfFile:@(argv[1])
                                                  encoding:NSUTF8StringEncoding error:NULL];
        NSString *list = [NSString stringWithContentsOfFile:@(argv[2])
                                                   encoding:NSUTF8StringEncoding error:NULL];
        NSMutableArray *paths = [NSMutableArray array];
        for (NSString *p in [list componentsSeparatedByString:@"\n"]) {
            if (p.length) [paths addObject:p];
        }
        [NSFileManager.defaultManager createFileAtPath:@(argv[3]) contents:nil attributes:nil];

        Runner *r = [[Runner alloc] init];
        r.paths = paths;
        r.out = [NSFileHandle fileHandleForWritingAtPath:@(argv[3])];
        WKWebViewConfiguration *cfg = [[WKWebViewConfiguration alloc] init];
        r.wv = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 1000, 800) configuration:cfg];
        r.wv.navigationDelegate = r;
        [r.wv loadHTMLString:tpl baseURL:nil];

        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:900];
        while (!r.finished && [deadline timeIntervalSinceNow] > 0) {
            [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode
                                  beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
        }
        [r.out closeFile];
        printf("checked=%lu contentLoss=%lu errors=%lu\n",
               (unsigned long)r.checked, (unsigned long)r.lost, (unsigned long)r.failed);
        return 0;
    }
}
