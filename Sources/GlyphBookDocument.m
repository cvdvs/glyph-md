#import "GlyphBookDocument.h"
#import <WebKit/WebKit.h>
#import "GlyphPDFDocument.h"
#import "MarkdownDocument.h"

// macOS has no reader for a book, so this is the same page the phone uses: the
// reader lives in viewer.html, and this class only hands it the file. It answers
// the page's one request, and every navigation stays refused.
@interface GlyphBookDocument () <WKNavigationDelegate, WKScriptMessageHandler, NSToolbarDelegate>
@property (nonatomic, strong) NSData *bytes;
@property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, assign) BOOL pageReady;
@end

// A base64 run of 3 bytes makes 4 characters, so a piece must end on a multiple of
// 3 or the page could not decode them separately.
static const NSUInteger kGlyphBookPiece = 3 * 1024 * 1024;

@implementation GlyphBookDocument

+ (BOOL)autosavesInPlace { return NO; }
+ (BOOL)canConcurrentlyReadDocumentsOfType:(NSString *)typeName { return NO; }

- (BOOL)readFromData:(NSData *)data ofType:(NSString *)typeName error:(NSError **)outError {
    const uint8_t *b = data.bytes;
    if (data.length < 4 || b[0] != 'P' || b[1] != 'K') {
        if (outError) {
            *outError = [NSError errorWithDomain:NSCocoaErrorDomain
                                            code:NSFileReadCorruptFileError
                                        userInfo:@{NSLocalizedDescriptionKey:
                                                   @"This file could not be read as a book."}];
        }
        return NO;
    }
    self.bytes = data;
    if (self.pageReady) [self sendBook];
    return YES;
}

// See GlyphPDFDocument: this fires when nothing changed, so it has to check.
- (void)presentedItemDidChange {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!self.fileURL) return;
        NSDate *onDisk = nil;
        [self.fileURL getResourceValue:&onDisk forKey:NSURLContentModificationDateKey error:NULL];
        if (!onDisk || [onDisk isEqualToDate:self.fileModificationDate]) return;
        [self revertToContentsOfURL:self.fileURL ofType:self.fileType error:NULL];
    });
}

- (void)makeWindowControllers {
    NSWindow *window = GlyphReaderWindow(self);
    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    [config.userContentController addScriptMessageHandler:self name:@"glyph"];
    WKWebView *web = [[WKWebView alloc] initWithFrame:window.contentView.bounds configuration:config];
    web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    web.navigationDelegate = self;
    window.contentView = web;
    self.webView = web;
    [self loadPage];

    NSWindowController *controller = [[NSWindowController alloc] initWithWindow:window];
    controller.shouldCascadeWindows = NO;
    [self addWindowController:controller];
}

// The book's folder is the page's address, so what the page remembers (your place,
// your settings) is kept rather than lost with a blank origin. The page has no way
// to read from it: file access stays off, and the policy has no network.
- (void)loadPage {
    self.pageReady = NO;
    [self.webView loadHTMLString:[MarkdownDocument viewerPage]
                         baseURL:self.fileURL.URLByDeletingLastPathComponent];
}

- (void)sendBook {
    NSData *bytes = self.bytes;
    NSString *key = self.fileURL.path ?: self.displayName;
    NSData *keyJSON = [NSJSONSerialization dataWithJSONObject:@[key] options:0 error:NULL];
    NSString *keyArray = [[NSString alloc] initWithData:keyJSON encoding:NSUTF8StringEncoding];
    WKWebView *web = self.webView;
    __weak GlyphBookDocument *weakSelf = self;
    __block void (^next)(NSUInteger);
    void (^step)(NSUInteger) = ^(NSUInteger offset) {
        if (offset >= bytes.length) {
            NSString *show = [NSString stringWithFormat:@"return await window.glyphBookShow(%@[0])", keyArray];
            [web callAsyncJavaScript:show arguments:nil inFrame:nil inContentWorld:WKContentWorld.pageWorld
                   completionHandler:^(id result, NSError *error) { [weakSelf bookOpened:result]; }];
            next = nil;
            return;
        }
        NSUInteger length = MIN(kGlyphBookPiece, bytes.length - offset);
        NSString *piece = [[bytes subdataWithRange:NSMakeRange(offset, length)]
                           base64EncodedStringWithOptions:0];
        NSString *js = [NSString stringWithFormat:@"window.glyphBookPiece('%@')", piece];
        [web evaluateJavaScript:js completionHandler:^(id r, NSError *e) { if (next) next(offset + length); }];
    };
    next = step;
    step(0);
}

- (void)bookOpened:(id)result {
    if (![result isKindOfClass:[NSString class]]) return;
    NSData *json = [(NSString *)result dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *info = [NSJSONSerialization JSONObjectWithData:json options:0 error:NULL];
    NSWindow *window = self.webView.window;
    NSString *title = [info[@"title"] isKindOfClass:[NSString class]] ? info[@"title"] : nil;
    NSString *author = [info[@"author"] isKindOfClass:[NSString class]] ? info[@"author"] : nil;
    if (title.length) window.title = title;
    if (author.length) window.subtitle = author;
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    self.pageReady = YES;
    if (self.bytes) [self sendBook];
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    [self loadPage];
}

// The page is loaded once and never navigates. Links reach -followURL: as messages.
- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)action
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    BOOL initial = action.navigationType == WKNavigationTypeOther && action.targetFrame.isMainFrame &&
                   !self.pageReady;
    decisionHandler(initial ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}

- (void)userContentController:(WKUserContentController *)controller
      didReceiveScriptMessage:(WKScriptMessage *)message {
    if (message.webView != self.webView || !message.frameInfo.isMainFrame) return;
    if (![message.body isKindOfClass:[NSDictionary class]]) return;
    NSDictionary *body = message.body;
    if (![body[@"type"] isEqual:@"openURL"] || ![body[@"url"] isKindOfClass:[NSString class]]) return;
    GlyphOpenWebLink([NSURL URLWithString:body[@"url"]]);
}

// The controller retains its handler, and the handler here is this document.
- (void)close {
    [self.webView.configuration.userContentController removeScriptMessageHandlerForName:@"glyph"];
    [super close];
}

- (NSArray<NSToolbarItemIdentifier> *)toolbarDefaultItemIdentifiers:(NSToolbar *)toolbar { return @[]; }
- (NSArray<NSToolbarItemIdentifier> *)toolbarAllowedItemIdentifiers:(NSToolbar *)toolbar { return @[]; }

- (BOOL)validateUserInterfaceItem:(id<NSValidatedUserInterfaceItem>)item {
    SEL a = item.action;
    if (a == @selector(saveDocument:) || a == @selector(saveDocumentAs:) ||
        a == @selector(revertDocumentToSaved:)) {
        return NO;
    }
    return [super validateUserInterfaceItem:item];
}

@end
