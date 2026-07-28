#import "GlyphGutter.h"
#import "GlyphHighlighter.h"
#import "GlyphTheme.h"

static const CGFloat kPadRight = 12;   // gap between the digits and the text

@interface GlyphGutter ()
@property (nonatomic, weak) GlyphHighlighter *highlighter;
@property (nonatomic, assign) NSUInteger digits;
@end

@implementation GlyphGutter

- (instancetype)initWithHighlighter:(GlyphHighlighter *)highlighter {
    self = [super init];
    if (self) {
        _highlighter = highlighter;
        _digits = 0;
        [self updateWidth];
    }
    return self;
}

- (BOOL)updateWidth {
    NSUInteger lines = MAX((NSUInteger)1, self.highlighter.lineCount);
    NSUInteger d = 1;
    for (NSUInteger v = lines; v >= 10; v /= 10) d++;
    if (d == self.digits) return NO;
    self.digits = d;
    _width = MAX(34.0, 10.0 + d * 8.0);
    return YES;
}

- (void)drawInTextView:(NSTextView *)tv dirtyRect:(NSRect)dirtyRect {
    GlyphHighlighter *hl = self.highlighter;
    NSLayoutManager *lm = tv.layoutManager;
    NSTextContainer *tc = tv.textContainer;
    if (!hl || !lm || !tc) return;

    NSString *text = tv.string;
    NSPoint origin = tv.textContainerOrigin;

    NSRange sel = tv.selectedRange;
    NSUInteger caretLine = [hl lineNumberForCharacterIndex:
                            MIN(sel.location, text.length ? text.length - 1 : 0)];
    BOOL spanSelected = sel.length > 0;
    BOOL focused = (tv.window.firstResponder == tv);

    NSDictionary *plain = @{
        NSFontAttributeName: [NSFont monospacedDigitSystemFontOfSize:11 weight:NSFontWeightRegular],
        NSForegroundColorAttributeName: GlyphFaint(),
    };
    NSDictionary *current = @{
        NSFontAttributeName: [NSFont monospacedDigitSystemFontOfSize:11 weight:NSFontWeightMedium],
        NSForegroundColorAttributeName: GlyphAccent(),
    };

    CGFloat right = self.width;   // digits are right-aligned to this x

    void (^drawNumber)(NSUInteger, CGFloat) = ^(NSUInteger number, CGFloat containerTop) {
        BOOL isCaret = focused && !spanSelected && (number == caretLine);
        NSDictionary *attrs = isCaret ? current : plain;
        NSString *label = [NSString stringWithFormat:@"%lu", (unsigned long)number];
        NSSize size = [label sizeWithAttributes:attrs];
        CGFloat y = containerTop + origin.y;
        y = round(y * 2.0) / 2.0;   // half-point snap, or digits blur on retina
        [label drawAtPoint:NSMakePoint(right - size.width, y) withAttributes:attrs];
    };

    // Only number the lines actually being redrawn.
    NSRect containerRect = NSOffsetRect(dirtyRect, -origin.x, -origin.y);
    NSRange glyphs = [lm glyphRangeForBoundingRect:containerRect inTextContainer:tc];

    NSUInteger glyphIndex = glyphs.location;
    while (glyphIndex < NSMaxRange(glyphs)) {
        NSRange fragRange = NSMakeRange(0, 0);
        NSRect fragment = [lm lineFragmentRectForGlyphAtIndex:glyphIndex
                                              effectiveRange:&fragRange];
        NSUInteger charIndex = [lm characterIndexForGlyphAtIndex:fragRange.location];
        // A wrapped continuation does not begin a logical line, so it gets no number.
        if ([hl isLineStart:charIndex]) {
            drawNumber([hl lineNumberForCharacterIndex:charIndex], NSMinY(fragment));
        }
        if (NSMaxRange(fragRange) <= glyphIndex) break;
        glyphIndex = NSMaxRange(fragRange);
    }

    // A document ending in a newline has one more (empty) line, which TextKit
    // reports separately. Editors number it; without this the last line is missing.
    if (text.length > 0 && [text characterAtIndex:text.length - 1] == '\n') {
        NSRect extra = lm.extraLineFragmentRect;
        if (!NSIsEmptyRect(extra) && NSIntersectsRect(NSOffsetRect(extra, origin.x, origin.y), dirtyRect)) {
            drawNumber(hl.lineCount, NSMinY(extra));
        }
    }
}

@end
