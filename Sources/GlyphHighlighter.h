// Markdown syntax coloring for the raw editor.
//
// One instance per document. It owns the document's structure model — where each
// line starts and what kind of line it is — which is the single source of truth
// the gutter also reads, so numbering and coloring can never disagree.
#import <Cocoa/Cocoa.h>

NS_ASSUME_NONNULL_BEGIN

@interface GlyphHighlighter : NSObject <NSTextStorageDelegate>

- (instancetype)initWithTextView:(NSTextView *)textView;

// NO while the raw view is hidden: typing in the formatted view syncs text into
// this storage constantly, and coloring text nobody is looking at is pure cost.
@property (nonatomic, assign) BOOL enabled;

// Wrap a wholesale -setString: so the delegate does not try to repair a document
// that is being replaced outright.
- (void)beginBulkReplace;
- (void)endBulkReplace;

- (void)highlightAll;

// Structure model, read by the gutter.
@property (nonatomic, readonly) NSUInteger lineCount;
- (NSUInteger)lineNumberForCharacterIndex:(NSUInteger)index;  // 1-based
- (BOOL)isLineStart:(NSUInteger)characterIndex;

@end

NS_ASSUME_NONNULL_END
