#import "GlyphTheme.h"
#import "GlyphGutter.h"

static NSColor *Dyn(uint32_t light, uint32_t dark) {
    return [NSColor colorWithName:nil dynamicProvider:^NSColor *(NSAppearance *ap) {
        NSAppearanceName match = [ap bestMatchFromAppearancesWithNames:
                                  @[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
        uint32_t v = [match isEqualToString:NSAppearanceNameDarkAqua] ? dark : light;
        return [NSColor colorWithSRGBRed:((v >> 16) & 0xFF) / 255.0
                                   green:((v >> 8) & 0xFF) / 255.0
                                    blue:(v & 0xFF) / 255.0
                                   alpha:1.0];
    }];
}

NSColor *GlyphBG(void)      { static NSColor *c; if (!c) c = Dyn(0xffffff, 0x1e1e26); return c; }
NSColor *GlyphFG(void)      { static NSColor *c; if (!c) c = Dyn(0x26272b, 0xd8dade); return c; }
NSColor *GlyphMuted(void)   { static NSColor *c; if (!c) c = Dyn(0x75797f, 0x9094a0); return c; }
NSColor *GlyphFaint(void)   { static NSColor *c; if (!c) c = Dyn(0xa9adb3, 0x5f6370); return c; }
NSColor *GlyphAccent(void)  { static NSColor *c; if (!c) c = Dyn(0x6944ff, 0x9c8bff); return c; }
// Line numbers. Muted rather than faint: faint measures 2.86:1 on the dark page,
// under the 3:1 floor for UI text, and the numbers were effectively invisible.
NSColor *GlyphGutterNumber(void) { return GlyphMuted(); }
NSColor *GlyphCodeBG(void)  { static NSColor *c; if (!c) c = Dyn(0xf4f4f7, 0x2a2a34); return c; }
NSColor *GlyphH1(void)      { static NSColor *c; if (!c) c = Dyn(0xd23b71, 0xef5d8d); return c; }
NSColor *GlyphH2(void)      { static NSColor *c; if (!c) c = Dyn(0xae761b, 0xe5ad4c); return c; }
NSColor *GlyphH3(void)      { static NSColor *c; if (!c) c = Dyn(0x178d99, 0x54bec4); return c; }
NSColor *GlyphH4(void)      { static NSColor *c; if (!c) c = Dyn(0x7a4fd0, 0xb48bf2); return c; }
NSColor *GlyphLink(void)    { static NSColor *c; if (!c) c = Dyn(0xc62f6d, 0xee6d95); return c; }
NSColor *GlyphQuote(void)   { static NSColor *c; if (!c) c = Dyn(0x6d5fb0, 0xa99bd6); return c; }

NSColor *GlyphHighlightBG(void) {
    static NSColor *c;
    if (!c) {
        c = [NSColor colorWithName:nil dynamicProvider:^NSColor *(NSAppearance *ap) {
            NSAppearanceName m = [ap bestMatchFromAppearancesWithNames:
                                  @[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
            CGFloat a = [m isEqualToString:NSAppearanceNameDarkAqua] ? 0.25 : 0.35;
            return [NSColor colorWithSRGBRed:1.0 green:208 / 255.0 blue:0.0 alpha:a];
        }];
    }
    return c;
}

// Mirrors tagClass() in viewer.html. The character class is spelled out rather
// than using \w because ICU's \w is Unicode-aware and JavaScript's is not — an
// accented tag would otherwise land on a different color in each view.
NSColor *GlyphTagColor(NSString *tag) {
    static NSArray<NSColor *> *palette;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        palette = @[Dyn(0xc62f6d, 0xef6a92), Dyn(0x9c6a12, 0xe5ad4c), Dyn(0x127f8b, 0x54bec4),
                    Dyn(0x3d8f52, 0x7cbf72), Dyn(0x7a4fd0, 0xb48bf2), Dyn(0x2e6cc9, 0x6ea6f5)];
    });
    uint32_t h = 0;
    for (NSUInteger i = 0; i < tag.length; i++) {
        h = (uint32_t)(h * 31u + [tag characterAtIndex:i]);
    }
    return palette[h % 6];
}

NSColor *GlyphCalloutColor(NSString *type) {
    static NSDictionary<NSString *, NSColor *> *map;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSColor *note = Dyn(0x4a8cff, 0x4a8cff), *tip = Dyn(0x2fb8a5, 0x2fb8a5);
        NSColor *warn = Dyn(0xe6a23c, 0xe6a23c), *danger = Dyn(0xf75c5c, 0xf75c5c);
        NSColor *success = Dyn(0x4fbb6b, 0x4fbb6b), *question = Dyn(0xdfae3d, 0xdfae3d);
        NSColor *quote = Dyn(0x9aa0a8, 0x9aa0a8), *example = Dyn(0xa06bff, 0xa06bff);
        NSColor *important = Dyn(0x3fb2d4, 0x3fb2d4);
        map = @{@"note": note, @"info": note, @"todo": note,
                @"tip": tip, @"hint": tip,
                @"warning": warn, @"caution": warn, @"attention": warn,
                @"danger": danger, @"error": danger, @"bug": danger,
                @"fail": danger, @"failure": danger, @"missing": danger,
                @"success": success, @"check": success, @"done": success,
                @"question": question, @"help": question, @"faq": question,
                @"quote": quote, @"cite": quote,
                @"abstract": important, @"summary": important, @"tldr": important,
                @"important": important,
                @"example": example};
    });
    NSColor *c = map[type.lowercaseString];
    return c ?: map[@"note"];
}

NSFont *GlyphMonoFont(void) {
    static NSFont *f;
    if (!f) f = [NSFont monospacedSystemFontOfSize:13.5 weight:NSFontWeightRegular];
    return f;
}

NSFont *GlyphMonoBoldFont(void) {
    static NSFont *f;
    if (!f) f = [NSFont monospacedSystemFontOfSize:13.5 weight:NSFontWeightSemibold];
    return f;
}

NSParagraphStyle *GlyphBaseParagraphStyle(void) {
    static NSParagraphStyle *p;
    if (!p) {
        NSMutableParagraphStyle *m = [[NSMutableParagraphStyle alloc] init];
        m.lineHeightMultiple = 1.32;
        p = [m copy];
    }
    return p;
}

NSDictionary<NSAttributedStringKey, id> *GlyphBaseAttributes(void) {
    static NSDictionary *d;
    if (!d) {
        d = @{NSFontAttributeName: GlyphMonoFont(),
              NSForegroundColorAttributeName: GlyphFG(),
              NSParagraphStyleAttributeName: GlyphBaseParagraphStyle()};
    }
    return d;
}

@implementation GlyphTextView

// AppKit re-derives typing attributes from the character preceding the caret on
// every selection change, so text typed right after a heading or a link would
// keep that color. Pinning them to the base makes new input always neutral; the
// highlighter recolors it in the same edit cycle.
- (NSDictionary<NSAttributedStringKey, id> *)typingAttributes {
    return GlyphBaseAttributes();
}

// Runs before the glyphs are drawn, in this view's own coordinates, and scrolls
// with the content automatically.
- (void)drawViewBackgroundInRect:(NSRect)rect {
    [super drawViewBackgroundInRect:rect];
    [self.gutter drawInTextView:self dirtyRect:rect];
}

- (void)syncGutterInset {
    if (!self.gutter) return;
    CGFloat inset = self.gutter.width + 14;
    if (fabs(self.textContainerInset.width - inset) > 0.5) {
        self.textContainerInset = NSMakeSize(inset, self.textContainerInset.height);
    }
}

// The caret line is highlighted, so the margin must repaint when it moves.
- (void)setSelectedRanges:(NSArray<NSValue *> *)ranges
             affinity:(NSSelectionAffinity)affinity
       stillSelecting:(BOOL)stillSelectingFlag {
    [super setSelectedRanges:ranges affinity:affinity stillSelecting:stillSelectingFlag];
    if (self.gutter) self.needsDisplay = YES;
}

@end
