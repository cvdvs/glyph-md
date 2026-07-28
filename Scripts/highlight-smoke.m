// Headless check of the raw editor's syntax highlighting.
//
//   clang -fobjc-arc Scripts/highlight-smoke.m Sources/GlyphTheme.m \
//         Sources/GlyphHighlighter.m -o /tmp/highlight-smoke -framework Cocoa
//   /tmp/highlight-smoke Scripts/fixtures/highlight-cases.md
//
// Builds the same TextKit 1 stack the app builds, runs the highlighter over a
// document of known cases, then asserts the color landed on the right characters.
// Colors are compared by identity because the theme vends cached singletons.
#import <Cocoa/Cocoa.h>
#import "../Sources/GlyphTheme.h"
#import "../Sources/GlyphHighlighter.h"

static int failures = 0;
static int checks = 0;

static NSTextStorage *gStorage = nil;
static NSString *gText = nil;

static NSRange RangeOf(NSString *needle) {
    NSRange r = [gText rangeOfString:needle];
    if (r.location == NSNotFound) {
        printf("  !! fixture missing %s\n", needle.UTF8String);
        failures++;
    }
    return r;
}

static NSColor *ColorAt(NSUInteger i) {
    if (i >= gStorage.length) return nil;
    return [gStorage attribute:NSForegroundColorAttributeName atIndex:i effectiveRange:NULL];
}

static NSFont *FontAt(NSUInteger i) {
    if (i >= gStorage.length) return nil;
    return [gStorage attribute:NSFontAttributeName atIndex:i effectiveRange:NULL];
}

static void Expect(const char *what, BOOL cond) {
    checks++;
    if (!cond) { printf("  FAIL  %s\n", what); failures++; }
    else printf("  ok    %s\n", what);
}

// The first character of `needle` carries color `expected`.
static void ExpectColor(const char *what, NSString *needle, NSColor *expected) {
    NSRange r = RangeOf(needle);
    if (r.location == NSNotFound) return;
    Expect(what, ColorAt(r.location) == expected);
}

static void ExpectColorAtOffset(const char *what, NSString *needle, NSUInteger off, NSColor *expected) {
    NSRange r = RangeOf(needle);
    if (r.location == NSNotFound) return;
    Expect(what, ColorAt(r.location + off) == expected);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        NSString *path = argc > 1 ? @(argv[1]) : @"Scripts/fixtures/highlight-cases.md";
        gText = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL];
        if (!gText) { fprintf(stderr, "cannot read %s\n", path.UTF8String); return 2; }

        NSTextStorage *storage = [[NSTextStorage alloc] init];
        NSLayoutManager *lm = [[NSLayoutManager alloc] init];
        lm.allowsNonContiguousLayout = YES;
        [storage addLayoutManager:lm];
        NSTextContainer *tc = [[NSTextContainer alloc] initWithContainerSize:NSMakeSize(800, FLT_MAX)];
        [lm addTextContainer:tc];
        GlyphTextView *tv = [[GlyphTextView alloc] initWithFrame:NSMakeRect(0, 0, 800, 600)
                                                   textContainer:tc];
        tv.richText = NO;
        tv.string = gText;
        gStorage = storage;

        GlyphHighlighter *hl = [[GlyphHighlighter alloc] initWithTextView:tv];
        hl.enabled = YES;

        printf("highlight-smoke (%lu chars, %lu lines)\n",
               (unsigned long)gText.length, (unsigned long)hl.lineCount);

        // --- headings map to the formatted view's colors ---
        ExpectColorAtOffset("H1 text is rose",       @"# Heading one", 2, GlyphH1());
        ExpectColorAtOffset("H2 text is gold",       @"## Heading two", 3, GlyphH2());
        ExpectColorAtOffset("H3 text is teal",       @"### Heading three", 4, GlyphH3());
        ExpectColorAtOffset("H4 text is lavender",   @"#### Heading four", 5, GlyphH4());
        ExpectColor("heading hashes are faint",      @"# Heading one", GlyphFaint());
        {
            NSRange r = RangeOf(@"# Heading one");
            if (r.location != NSNotFound) Expect("heading text is semibold",
                FontAt(r.location + 2) == GlyphMonoBoldFont());
        }

        // --- the trap: a line starting with a tag is NOT a heading ---
        ExpectColor("#design at line start is a tag, not H1", @"#design", GlyphTagColor(@"design"));

        // --- the trap: identifiers must not become italic/bold ---
        {
            NSRange r = RangeOf(@"snake_case_name");
            if (r.location != NSNotFound) {
                id ob = [gStorage attribute:NSObliquenessAttributeName
                                    atIndex:r.location + 6 effectiveRange:NULL];
                Expect("snake_case is not italicized", ob == nil);
            }
            NSRange r2 = RangeOf(@"__init__");
            if (r2.location != NSNotFound) {
                Expect("__init__ is bold, matching what marked.js renders",
                       FontAt(r2.location + 2) == GlyphMonoBoldFont());
            }
        }

        // --- emphasis ---
        {
            NSRange r = RangeOf(@"**bold words**");
            if (r.location != NSNotFound) {
                Expect("bold markers are faint", ColorAt(r.location) == GlyphFaint());
                Expect("bold content is semibold", FontAt(r.location + 2) == GlyphMonoBoldFont());
            }
            NSRange ri = RangeOf(@"*italic words*");
            if (ri.location != NSNotFound) {
                id ob = [gStorage attribute:NSObliquenessAttributeName
                                    atIndex:ri.location + 2 effectiveRange:NULL];
                Expect("italic content is oblique", ob != nil);
            }
        }

        // --- links, wikilinks, code, highlight ---
        ExpectColorAtOffset("link label is link-colored", @"[label](https://x.dev)", 1, GlyphLink());
        ExpectColorAtOffset("link url is muted",          @"[label](https://x.dev)", 9, GlyphMuted());
        ExpectColorAtOffset("wikilink target is link-colored", @"[[Some Note]]", 2, GlyphLink());
        {
            NSRange r = RangeOf(@"`inline code`");
            if (r.location != NSNotFound) {
                id bg = [gStorage attribute:NSBackgroundColorAttributeName
                                    atIndex:r.location + 2 effectiveRange:NULL];
                Expect("inline code has a chip background", bg == GlyphCodeBG());
            }
            NSRange rh = RangeOf(@"==marked text==");
            if (rh.location != NSNotFound) {
                id bg = [gStorage attribute:NSBackgroundColorAttributeName
                                    atIndex:rh.location + 3 effectiveRange:NULL];
                Expect("highlight has a yellow background", bg == GlyphHighlightBG());
            }
        }

        // --- fenced code: contents must NOT be re-highlighted as markdown ---
        ExpectColor("fence body ignores markdown syntax", @"# not a heading inside a fence", GlyphFG());
        ExpectColor("fence language tag is colored", @"```python", GlyphFaint());

        // --- frontmatter ---
        ExpectColor("frontmatter key is muted", @"title:", GlyphMuted());
        ExpectColorAtOffset("frontmatter value is accent", @"title: Fixture", 7, GlyphAccent());

        // --- quote and callout ---
        ExpectColorAtOffset("blockquote body is violet", @"> a plain quote", 2, GlyphQuote());
        ExpectColorAtOffset("callout type takes its family color", @"> [!warning] Careful",
                            2, GlyphCalloutColor(@"warning"));

        // --- tables ---
        {
            NSRange r = RangeOf(@"| Col A | Col B |");
            if (r.location != NSNotFound) {
                Expect("table pipe is faint", ColorAt(r.location) == GlyphFaint());
                Expect("table header text is muted", ColorAt(r.location + 2) == GlyphMuted());
            }
        }

        // --- task list ---
        {
            NSRange r = RangeOf(@"- [x] finished task");
            if (r.location != NSNotFound) {
                Expect("checked mark uses accent", ColorAt(r.location + 3) == GlyphAccent());
                id st = [gStorage attribute:NSStrikethroughStyleAttributeName
                                    atIndex:r.location + 6 effectiveRange:NULL];
                Expect("finished task text is struck through", st != nil);
            }
        }

        // --- horizontal rule vs frontmatter vs setext: all spelled --- ---
        ExpectColor("horizontal rule is faint", @"---\n\nAfter the rule", GlyphFaint());

        // --- structure model, which the gutter reads ---
        Expect("line 1 starts at index 0", [hl lineNumberForCharacterIndex:0] == 1);
        Expect("index 0 is a line start", [hl isLineStart:0]);
        {
            NSRange r = RangeOf(@"# Heading one");
            if (r.location != NSNotFound) {
                Expect("heading is at a line start", [hl isLineStart:r.location]);
                Expect("mid-heading is not a line start", ![hl isLineStart:r.location + 3]);
            }
        }

        // --- paragraph style survives token attribution (setAttributes would drop it) ---
        {
            NSRange r = RangeOf(@"**bold words**");
            if (r.location != NSNotFound) {
                NSParagraphStyle *ps = [gStorage attribute:NSParagraphStyleAttributeName
                                                   atIndex:r.location + 2 effectiveRange:NULL];
                Expect("line spacing survives inside a styled token",
                       ps && fabs(ps.lineHeightMultiple - 1.32) < 0.001);
            }
        }

        printf("\n%d checks, %d failures\n", checks, failures);
        return failures ? 1 : 0;
    }
}
