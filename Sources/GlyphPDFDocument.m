#import "GlyphPDFDocument.h"
#import <PDFKit/PDFKit.h>
#import "GlyphTheme.h"

// The Mac has PDFKit, so nothing from the phone's PDF.js comes along: every scan
// format macOS can read works, text selects and copies, and links are live.
//
// It is a separate document class rather than a mode of MarkdownDocument because
// that class is built around a text it can save. Nothing here can write.
@interface GlyphPDFDocument () <PDFViewDelegate, NSToolbarDelegate>
@property (nonatomic, strong) PDFDocument *pdf;
@property (nonatomic, strong) PDFView *pdfView;
@end

NSWindow *GlyphReaderWindow(id<NSToolbarDelegate> toolbarDelegate) {
    NSWindow *window = [[NSWindow alloc]
        initWithContentRect:NSMakeRect(0, 0, 940, 800)
                  styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                             NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable)
                    backing:NSBackingStoreBuffered
                      defer:YES];
    window.releasedWhenClosed = NO;
    window.minSize = NSMakeSize(480, 360);
    window.backgroundColor = GlyphBG();
    // The same group as the notes, so it opens as a tab beside them.
    window.tabbingIdentifier = @"glyph";
    window.tabbingMode = NSWindowTabbingModePreferred;
    window.toolbarStyle = NSWindowToolbarStyleUnified;
    [window center];

    // Empty, but it holds the title bar at the height a note's has, so switching
    // between the two tabs does not make the window jump.
    NSToolbar *toolbar = [[NSToolbar alloc] initWithIdentifier:@"glyph-reader-toolbar"];
    toolbar.delegate = toolbarDelegate;
    toolbar.displayMode = NSToolbarDisplayModeIconOnly;
    toolbar.allowsUserCustomization = NO;
    window.toolbar = toolbar;
    return window;
}

// Web and mail only, never a file or a custom scheme (rule 12).
void GlyphOpenWebLink(NSURL *url) {
    NSString *scheme = url.scheme.lowercaseString;
    if ([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"] ||
        [scheme isEqualToString:@"mailto"]) {
        [NSWorkspace.sharedWorkspace openURL:url];
    }
}

@implementation GlyphPDFDocument

+ (BOOL)autosavesInPlace { return NO; }
+ (BOOL)canConcurrentlyReadDocumentsOfType:(NSString *)typeName { return NO; }

- (BOOL)readFromURL:(NSURL *)url ofType:(NSString *)typeName error:(NSError **)outError {
    PDFDocument *pdf = [[PDFDocument alloc] initWithURL:url];
    if (!pdf) {
        if (outError) {
            *outError = [NSError errorWithDomain:NSCocoaErrorDomain
                                            code:NSFileReadCorruptFileError
                                        userInfo:@{NSLocalizedDescriptionKey:
                                                   @"This file could not be read as a PDF."}];
        }
        return NO;
    }
    self.pdf = pdf;
    if (self.pdfView) {
        self.pdfView.document = pdf;
        [self updatePageCount];
    }
    // PDFView asks for a password itself when a file is locked.
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(pdfUnlocked:)
                                               name:PDFDocumentDidUnlockNotification object:pdf];
    return YES;
}

- (void)pdfUnlocked:(NSNotification *)note { [self updatePageCount]; }

// A viewer has nothing to autosave, so NSDocument leaves a changed file alone by
// default. Rule 25 applies here too: the file on screen must match the one on disk.
// But this also fires when nothing changed, because reading the file counts, so
// it has to check. Reloading on the report alone read the PDF about once a second
// forever, and every read blanked the page and sent it back to the top.
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
    PDFView *view = [[PDFView alloc] initWithFrame:window.contentView.bounds];
    view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    view.backgroundColor = GlyphBG();
    view.displayMode = kPDFDisplaySinglePageContinuous;
    view.displaysPageBreaks = YES;
    view.autoScales = YES;
    view.delegate = self;
    view.document = self.pdf;
    window.contentView = view;
    self.pdfView = view;

    NSWindowController *controller = [[NSWindowController alloc] initWithWindow:window];
    controller.shouldCascadeWindows = NO;
    [self addWindowController:controller];
    [self updatePageCount];
}

- (void)updatePageCount {
    NSUInteger n = self.pdf.pageCount;
    self.pdfView.window.subtitle = self.pdf.isLocked ? @"Locked" :
        [NSString stringWithFormat:@"%lu %@", (unsigned long)n, n == 1 ? @"page" : @"pages"];
}

- (NSArray<NSToolbarItemIdentifier> *)toolbarDefaultItemIdentifiers:(NSToolbar *)toolbar { return @[]; }
- (NSArray<NSToolbarItemIdentifier> *)toolbarAllowedItemIdentifiers:(NSToolbar *)toolbar { return @[]; }

// A PDF is untrusted input like a note. Without this delegate method PDFKit hands
// every link to the system itself.
- (void)PDFViewWillClickOnLink:(PDFView *)sender withURL:(NSURL *)url {
    GlyphOpenWebLink(url);
}

// View > Fit to Window. Zooming switches PDFKit's own fitting off.
- (void)zoomToFit:(id)sender { self.pdfView.autoScales = YES; }

- (BOOL)validateUserInterfaceItem:(id<NSValidatedUserInterfaceItem>)item {
    SEL a = item.action;
    if (a == @selector(saveDocument:) || a == @selector(saveDocumentAs:) ||
        a == @selector(revertDocumentToSaved:)) {
        return NO;
    }
    return [super validateUserInterfaceItem:item];
}

@end
