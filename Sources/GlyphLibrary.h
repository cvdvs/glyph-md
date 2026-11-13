#import <Cocoa/Cocoa.h>

// The Notes window: the phone server's own page, laid out for a wide window, so
// the Mac and the phone show the same folders, notes, readers and dictation.
@interface GlyphLibrary : NSObject
+ (instancetype)shared;
// The server on this Mac has paired before, so there is a token to open it with.
+ (BOOL)available;
- (void)show;
// Where a file sits inside the folder this Mac's server serves ("Work/plan.md"),
// or nil when it is somewhere else or no server is set up to start at login.
+ (NSString *)servedPathForURL:(NSURL *)url;
// The same question for any folder; nil when the file is not inside it.
+ (NSString *)pathOf:(NSURL *)url inFolder:(NSString *)folder;
// Opens that note in this window and shows it. NO when the page could not, so
// the caller can open the file in a window of its own instead.
- (void)openServedPath:(NSString *)path completion:(void (^)(BOOL opened))done;
@end
