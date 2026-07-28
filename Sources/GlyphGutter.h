// Line numbers for the raw editor, drawn flush against the page rather than in a
// tinted rail — the way Cursor, VS Code and Obsidian do it.
//
// Numbers are LOGICAL: one per paragraph. A soft-wrapped paragraph gets its
// number on the first display line and nothing on the continuations, which is
// what makes the gutter meaningful in a document full of long prose lines.
//
// This is NOT a view. The numbers are painted into the text view's own left
// margin from -drawViewBackgroundInRect:. Both an NSRulerView and a sibling view
// were tried first, and each one stopped the text view drawing its glyphs at all
// — correct geometry, correct attributes, blank screen. Painting inside the text
// view removes that whole class of failure, and the numbers then scroll with
// their lines for free, with no scroll observers and no coordinate conversion.
#import <Cocoa/Cocoa.h>

@class GlyphHighlighter;

NS_ASSUME_NONNULL_BEGIN

@interface GlyphGutter : NSObject

- (instancetype)initWithHighlighter:(GlyphHighlighter *)highlighter;

// Width needed for the current line count, including padding.
@property (nonatomic, readonly) CGFloat width;
- (BOOL)updateWidth;   // YES when it changed and the text inset needs reapplying

- (void)drawInTextView:(NSTextView *)textView dirtyRect:(NSRect)dirtyRect;

@end

NS_ASSUME_NONNULL_END
