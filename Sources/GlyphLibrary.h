#import <Cocoa/Cocoa.h>

// The Notes window: the phone server's own page, laid out for a wide window, so
// the Mac and the phone show the same folders, notes, readers and dictation.
@interface GlyphLibrary : NSObject
+ (instancetype)shared;
// The server on this Mac has paired before, so there is a token to open it with.
+ (BOOL)available;
- (void)show;
@end
