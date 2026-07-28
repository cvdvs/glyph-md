#import "GlyphGutter.h"
#import "GlyphHighlighter.h"
#import "GlyphTheme.h"

@interface GlyphGutter ()
// Weak: NSScrollView retains the ruler, and the ruler's clientView is the text
// view. Holding either strongly would leak a whole document per tab.
@property (nonatomic, weak) NSTextView *tv;
@property (nonatomic, weak) GlyphHighlighter *highlighter;
@property (nonatomic, assign) NSUInteger lastDigits;
@end

@implementation GlyphGutter

- (instancetype)initWithTextView:(NSTextView *)textView
                     highlighter:(GlyphHighlighter *)highlighter {
    NSScrollView *sv = textView.enclosingScrollView;
    self = [super initWithScrollView:sv orientation:NSVerticalRuler];
    if (self) {
        _tv = textView;
        _highlighter = highlighter;
        _lastDigits = 0;
        self.clientView = textView;
        self.ruleThickness = 46;

        // Scroll and edits redraw the ruler on their own; a selection change does
        // not, so the caret-line highlight would never move without this.
        [NSNotificationCenter.defaultCenter addObserver:self
                                               selector:@selector(selectionChanged:)
                                                   name:NSTextViewDidChangeSelectionNotification
                                                 object:textView];
        [NSNotificationCenter.defaultCenter addObserver:self
                                               selector:@selector(textChanged:)
                                                   name:NSTextDidChangeNotification
                                                 object:textView];
    }
    return self;
}

- (void)dealloc {
    [NSNotificationCenter.defaultCenter removeObserver:self];
}

- (void)selectionChanged:(NSNotification *)n { self.needsDisplay = YES; }
- (void)textChanged:(NSNotification *)n { [self refresh]; }

- (void)refresh {
    NSUInteger lines = MAX((NSUInteger)1, self.highlighter.lineCount);
    NSUInteger digits = 1;
    for (NSUInteger v = lines; v >= 10; v /= 10) digits++;
    if (digits != self.lastDigits) {
        self.lastDigits = digits;
        // Only ASSIGNING ruleThickness re-tiles the scroll view; returning a new
        // value from -requiredThickness after the first tile does nothing.
        self.ruleThickness = MAX(38.0, 16.0 + digits * 8.0);
    }
    self.needsDisplay = YES;
}

- (void)drawHashMarksAndLabelsInRect:(NSRect)rect {
    NSTextView *tv = self.tv;
    GlyphHighlighter *hl = self.highlighter;
    if (!tv || !hl) return;

    NSLayoutManager *lm = tv.layoutManager;
    NSTextContainer *tc = tv.textContainer;
    NSClipView *clip = self.scrollView.contentView;
    if (!lm || !tc || !clip) return;

    [GlyphBG() set];
    NSRectFill(rect);

    NSString *text = tv.string;
    CGFloat originY = tv.textContainerOrigin.y;
    CGFloat scrollY = NSMinY(clip.bounds);

    // Only the paragraph that holds the caret gets the accent color.
    NSRange sel = tv.selectedRange;
    NSUInteger caretLine = [hl lineNumberForCharacterIndex:
                            MIN(sel.location, text.length ? text.length - 1 : 0)];
    BOOL hasSelectionSpan = sel.length > 0;

    NSDictionary *plain = @{
        NSFontAttributeName: [NSFont monospacedDigitSystemFontOfSize:11 weight:NSFontWeightRegular],
        NSForegroundColorAttributeName: GlyphFaint(),
    };
    NSDictionary *current = @{
        NSFontAttributeName: [NSFont monospacedDigitSystemFontOfSize:11 weight:NSFontWeightMedium],
        NSForegroundColorAttributeName: GlyphAccent(),
    };

    CGFloat width = NSWidth(self.bounds);
    NSRange visibleGlyphs = [lm glyphRangeForBoundingRect:clip.documentVisibleRect
                                          inTextContainer:tc];

    NSUInteger glyphIndex = visibleGlyphs.location;
    while (glyphIndex < NSMaxRange(visibleGlyphs)) {
        NSRange fragmentGlyphRange = NSMakeRange(0, 0);
        NSRect fragment = [lm lineFragmentRectForGlyphAtIndex:glyphIndex
                                              effectiveRange:&fragmentGlyphRange];
        NSUInteger charIndex = [lm characterIndexForGlyphAtIndex:fragmentGlyphRange.location];

        // A wrapped continuation does not begin a logical line, so it gets no number.
        if ([hl isLineStart:charIndex]) {
            NSUInteger number = [hl lineNumberForCharacterIndex:charIndex];
            BOOL isCaretLine = (number == caretLine) && !hasSelectionSpan;
            NSString *label = [NSString stringWithFormat:@"%lu", (unsigned long)number];
            NSDictionary *attrs = isCaretLine ? current : plain;
            NSSize size = [label sizeWithAttributes:attrs];
            CGFloat y = NSMinY(fragment) + originY - scrollY;
            y = round(y * 2.0) / 2.0;   // half-point snap, or digits blur on retina
            [label drawAtPoint:NSMakePoint(width - size.width - 10, y) withAttributes:attrs];
        }

        if (NSMaxRange(fragmentGlyphRange) <= glyphIndex) break;
        glyphIndex = NSMaxRange(fragmentGlyphRange);
    }

    // A document ending in a newline has one more (empty) line, which TextKit
    // reports separately. Editors number it; without this the last line is missing.
    if (text.length > 0 && [text characterAtIndex:text.length - 1] == '\n') {
        NSRect extra = lm.extraLineFragmentRect;
        if (!NSIsEmptyRect(extra)) {
            NSUInteger number = hl.lineCount;
            BOOL isCaretLine = (number == caretLine) && !hasSelectionSpan;
            NSString *label = [NSString stringWithFormat:@"%lu", (unsigned long)number];
            NSDictionary *attrs = isCaretLine ? current : plain;
            NSSize size = [label sizeWithAttributes:attrs];
            CGFloat y = NSMinY(extra) + originY - scrollY;
            y = round(y * 2.0) / 2.0;
            [label drawAtPoint:NSMakePoint(width - size.width - 10, y) withAttributes:attrs];
        }
    }
}

@end
