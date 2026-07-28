#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface MarkdownDocument : NSDocument <WKNavigationDelegate, NSTextViewDelegate, NSToolbarDelegate>

@property (nonatomic, copy) NSString *text;

- (void)toggleEditMode:(id)sender;

@end
