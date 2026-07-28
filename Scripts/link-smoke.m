// What a clicked link is allowed to do — the decision table from
// Sources/MarkdownDocument.m, exercised directly.
//
//   clang -fobjc-arc Scripts/link-smoke.m -o /tmp/link-smoke -framework Foundation
//   /tmp/link-smoke <a writable temp dir>
//
// Links between notes must work (they are how a wiki is written) while a link
// to anything executable must not. Keep this in sync with GlyphActionForURL;
// the copy below is deliberate so the test needs no AppKit.
#import <Foundation/Foundation.h>
typedef NS_ENUM(NSInteger, GlyphLinkAction) {
    GlyphLinkIgnore = 0,
    GlyphLinkOpenExternally,
    GlyphLinkOpenAsDocument,
};

static GlyphLinkAction GlyphActionForURL(NSURL *url) {
    if (!url) return GlyphLinkIgnore;
    NSString *scheme = url.scheme.lowercaseString;
    if (!scheme) return GlyphLinkIgnore;
    if ([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"] ||
        [scheme isEqualToString:@"mailto"]) {
        return GlyphLinkOpenExternally;
    }
    if ([scheme isEqualToString:@"file"]) {
        static NSSet *markdown;
        static dispatch_once_t once;
        dispatch_once(&once, ^{
            markdown = [NSSet setWithArray:@[@"md", @"markdown", @"mdown", @"mkd"]];
        });
        BOOL isDir = NO;
        if ([markdown containsObject:url.pathExtension.lowercaseString] &&
            [NSFileManager.defaultManager fileExistsAtPath:url.path isDirectory:&isDir] && !isDir) {
            return GlyphLinkOpenAsDocument;
        }
    }
    return GlyphLinkIgnore;
}

static int fails = 0;
static void Check(const char *what, NSString *u, GlyphLinkAction want) {
    GlyphLinkAction got = GlyphActionForURL(u ? [NSURL URLWithString:u] : nil);
    const char *names[] = {"ignore", "external", "document"};
    if (got != want) { printf("  FAIL %-46s got %s want %s\n", what, names[got], names[want]); fails++; }
    else printf("  ok   %-46s %s\n", what, names[got]);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSString *dir = @(argv[1]);
        NSString *note = [dir stringByAppendingPathComponent:@"other.md"];
        NSString *script = [dir stringByAppendingPathComponent:@"evil.command"];
        [@"# hi" writeToFile:note atomically:YES encoding:NSUTF8StringEncoding error:NULL];
        [@"echo pwned" writeToFile:script atomically:YES encoding:NSUTF8StringEncoding error:NULL];
        NSString *noteURL = [NSURL fileURLWithPath:note].absoluteString;
        NSString *scriptURL = [NSURL fileURLWithPath:script].absoluteString;
        NSString *missing = [NSURL fileURLWithPath:
            [dir stringByAppendingPathComponent:@"nope.md"]].absoluteString;

        Check("https link", @"https://example.com", GlyphLinkOpenExternally);
        Check("mailto link", @"mailto:a@b.c", GlyphLinkOpenExternally);
        Check("note-to-note link (the regression)", noteURL, GlyphLinkOpenAsDocument);
        Check("link to a shell script", scriptURL, GlyphLinkIgnore);
        Check("link to a missing note", missing, GlyphLinkIgnore);
        Check("javascript: url", @"javascript:alert(1)", GlyphLinkIgnore);
        Check("custom app scheme", @"someapp://do-a-thing", GlyphLinkIgnore);
        Check("directory with .md name", [NSURL fileURLWithPath:dir].absoluteString, GlyphLinkIgnore);
        Check("nil", nil, GlyphLinkIgnore);
        printf("\n%s\n", fails ? "FAILURES" : "all pass");
        return fails ? 1 : 0;
    }
}
