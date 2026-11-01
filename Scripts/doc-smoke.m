// The Mac app's documents, through the real NSDocumentController and the real
// Info.plist: a PDF opens as a tab and stays read-only, and a note that is only
// read is never written back.
//
//   Scripts/doc-smoke.sh          builds this into a copy of build/Glyph.app and runs it
//
// It has to live inside an app bundle. The document types come from the bundle's
// Info.plist and the page from its Resources, and both are part of what is tested.
#import <Cocoa/Cocoa.h>
#import <PDFKit/PDFKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

static int gFails = 0;
static NSInteger gOpened = 0;

static void pump(double secs, BOOL (^done)(void)) {
    NSDate *end = [NSDate dateWithTimeIntervalSinceNow:secs];
    while ([end timeIntervalSinceNow] > 0) {
        if (done && done()) return;
        NSEvent *ev = [NSApp nextEventMatchingMask:NSEventMaskAny
                                         untilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]
                                            inMode:NSDefaultRunLoopMode dequeue:YES];
        if (ev) [NSApp sendEvent:ev];
    }
}

static void check(const char *name, BOOL ok, NSString *detail) {
    printf("  %s  %s%s%s\n", ok ? "ok  " : "FAIL", name,
           detail.length ? "   " : "", detail.length ? detail.UTF8String : "");
    if (!ok) gFails++;
}

// Counts instead of launching anything.
@interface NSWorkspace (GlyphTest)
- (BOOL)glyphTestOpenURL:(NSURL *)url;
@end
@implementation NSWorkspace (GlyphTest)
- (BOOL)glyphTestOpenURL:(NSURL *)url { gOpened++; return YES; }
@end

@interface CloseAnswer : NSObject
@property (nonatomic, assign) BOOL answered;
@end
@implementation CloseAnswer
- (void)document:(NSDocument *)d shouldClose:(BOOL)close contextInfo:(void *)info { self.answered = YES; }
@end

// Counts every time a note is read from disk.
static int gNoteReads = 0;
static IMP gRealNoteRead;
static BOOL countingRead(id s, SEL c, NSData *d, NSString *t, NSError **e) {
    gNoteReads++;
    return ((BOOL (*)(id, SEL, NSData *, NSString *, NSError **))gRealNoteRead)(s, c, d, t, e);
}

static NSDocument *openDoc(NSURL *url, NSError **outError) {
    __block NSDocument *doc = nil;
    __block NSError *err = nil;
    __block BOOL done = NO;
    [[NSDocumentController sharedDocumentController]
        openDocumentWithContentsOfURL:url display:YES
                    completionHandler:^(NSDocument *d, BOOL already, NSError *e) {
        doc = d; err = e; done = YES;
    }];
    pump(10, ^BOOL{ return done; });
    if (outError) *outError = err;
    return doc;
}

// Three pages, drawn here so the test owns no binary. With a password it is locked.
static void writePdf(NSString *path, NSString *password) {
    CGRect box = CGRectMake(0, 0, 595, 842);
    NSDictionary *opts = password ? @{(__bridge id)kCGPDFContextUserPassword: password,
                                      (__bridge id)kCGPDFContextOwnerPassword: password} : @{};
    CGContextRef c = CGPDFContextCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:path], &box,
                                               (__bridge CFDictionaryRef)opts);
    for (int i = 0; i < 3; i++) {
        CGContextBeginPage(c, &box);
        CGContextFillRect(c, CGRectMake(60, 60, 475, 700));
        CGContextEndPage(c);
    }
    CGContextRelease(c);
}

// Every path that could write a note, against a note the serializer would tidy.
static void readOnlyNote(NSString *dir) {
    NSString *path = [dir stringByAppendingPathComponent:@"untidy.md"];
    NSString *original = @"# Note\n\n* star bullet\n* another\n\n__bold__ and _em_\n";
    [original writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:NULL];

    Method read = class_getInstanceMethod(NSClassFromString(@"MarkdownDocument"),
                                          @selector(readFromData:ofType:error:));
    gRealNoteRead = method_setImplementation(read, (IMP)countingRead);
    NSDocument *doc = openDoc([NSURL fileURLWithPath:path], NULL);
    check("a note opens as a note", [doc isKindOfClass:NSClassFromString(@"MarkdownDocument")], @"");
    pump(15, ^BOOL{ return [[doc valueForKey:@"roundTripChecked"] boolValue]; });
    check("its page came up", [[doc valueForKey:@"pageReady"] boolValue], @"");
    pump(3.2, nil);
    check("a note is read once, then left alone", gNoteReads == 1,
          [NSString stringWithFormat:@"%d reads", gNoteReads]);

    [doc saveDocument:nil];
    pump(1.5, nil);
    NSString *afterSave = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL];
    check("saving a note nobody edited leaves the file alone", [afterSave isEqualToString:original], afterSave);

    CloseAnswer *answer = [[CloseAnswer alloc] init];
    [doc canCloseDocumentWithDelegate:answer
                  shouldCloseSelector:@selector(document:shouldClose:contextInfo:)
                          contextInfo:NULL];
    pump(5, ^BOOL{ return answer.answered; });
    check("closing it does not mark it edited", !doc.isDocumentEdited, @"");
    [doc close];
    pump(1, nil);
    NSString *afterClose = [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:NULL];
    check("closing it leaves the file alone", [afterClose isEqualToString:original], afterClose);

    // Claude Code sessions rewrite the very notes that are open (rule 25).
    NSString *livePath = [dir stringByAppendingPathComponent:@"rewritten.md"];
    [@"# Before\n" writeToFile:livePath atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    NSDocument *live = openDoc([NSURL fileURLWithPath:livePath], NULL);
    pump(1.5, nil);
    [@"# After\n" writeToFile:livePath atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    pump(6, ^BOOL{ return [[live valueForKey:@"text"] isEqualToString:@"# After\n"]; });
    check("a note that really changes on disk reloads",
          [[live valueForKey:@"text"] isEqualToString:@"# After\n"], [live valueForKey:@"text"]);
    [live close];
}

static void pdf(NSString *dir) {
    NSString *path = [dir stringByAppendingPathComponent:@"book.pdf"];
    writePdf(path, nil);
    NSData *before = [NSData dataWithContentsOfFile:path];

    NSString *notePath = [dir stringByAppendingPathComponent:@"beside.md"];
    [@"# Beside\n" writeToFile:notePath atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    NSDocument *note = openDoc([NSURL fileURLWithPath:notePath], NULL);

    NSError *err = nil;
    NSDocument *doc = openDoc([NSURL fileURLWithPath:path], &err);
    check("a PDF opens", doc != nil, err.localizedDescription ?: @"");
    check("as a PDF document", [doc isKindOfClass:NSClassFromString(@"GlyphPDFDocument")],
          NSStringFromClass(doc.class));
    PDFView *view = [doc valueForKey:@"pdfView"];
    check("with all its pages", view.document.pageCount == 3,
          [NSString stringWithFormat:@"%lu", (unsigned long)view.document.pageCount]);
    NSImage *thumb = [[view.document pageAtIndex:0] thumbnailOfSize:NSMakeSize(60, 84)
                                                             forBox:kPDFDisplayBoxMediaBox];
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithData:thumb.TIFFRepresentation];
    CGFloat w = [rep colorAtX:rep.pixelsWide / 2 y:rep.pixelsHigh / 2].brightnessComponent;
    check("and the page has ink on it", w < 0.5, [NSString stringWithFormat:@"%.2f", w]);
    // Reading a PDF is itself reported as the file changing, so reloading on that
    // report alone reads it again about once a second, forever: the page blanks
    // and jumps back to the top.
    PDFDocument *first = view.document;
    pump(3.2, nil);
    check("a PDF is read once, then left alone", view.document == first, @"");
    check("the page count is in the title bar", [view.window.subtitle isEqualToString:@"3 pages"],
          view.window.subtitle);
    NSWindow *noteWindow = note.windowControllers.firstObject.window;
    check("it opened as a tab beside the note",
          [noteWindow.tabbedWindows containsObject:view.window], @"");
    check("it counts as edited for nothing", !doc.isDocumentEdited, @"");
    check("it cannot be saved", ![[doc.class writableTypes] count],
          [[doc.class writableTypes] componentsJoinedByString:@","]);
    NSMenuItem *saveItem = [[NSMenuItem alloc] initWithTitle:@"Save" action:@selector(saveDocument:)
                                               keyEquivalent:@""];
    check("Save is greyed out", ![(id<NSUserInterfaceValidations>)doc validateUserInterfaceItem:saveItem], @"");

    // A PDF is untrusted, so its links get the rule a note's links get.
    Method real = class_getInstanceMethod(NSWorkspace.class, @selector(openURL:));
    Method fake = class_getInstanceMethod(NSWorkspace.class, @selector(glyphTestOpenURL:));
    method_exchangeImplementations(real, fake);
    id<PDFViewDelegate> del = view.delegate;
    [del PDFViewWillClickOnLink:view withURL:[NSURL URLWithString:@"https://example.com"]];
    check("a web link opens", gOpened == 1, @"");
    [del PDFViewWillClickOnLink:view withURL:[NSURL URLWithString:@"file:///System/Applications/Calculator.app"]];
    [del PDFViewWillClickOnLink:view withURL:[NSURL URLWithString:@"x-apple.systempreferences:foo"]];
    check("a link to a file or an app does nothing", gOpened == 1,
          [NSString stringWithFormat:@"%ld opened", (long)gOpened]);
    method_exchangeImplementations(real, fake);

    [doc close];
    [note close];
    check("the PDF is byte for byte what it was", [[NSData dataWithContentsOfFile:path] isEqual:before], @"");

    // And a real change still comes through.
    NSString *livePath = [dir stringByAppendingPathComponent:@"live.pdf"];
    writePdf(livePath, nil);
    NSDocument *live = openDoc([NSURL fileURLWithPath:livePath], NULL);
    PDFView *liveView = [live valueForKey:@"pdfView"];
    pump(1.5, nil);
    PDFDocument *shorter = [[PDFDocument alloc] initWithURL:[NSURL fileURLWithPath:livePath]];
    [shorter removePageAtIndex:0];
    [[shorter dataRepresentation] writeToFile:livePath atomically:YES];
    pump(6, ^BOOL{ return liveView.document.pageCount == 2; });
    check("a file that really changes on disk reloads", liveView.document.pageCount == 2,
          [NSString stringWithFormat:@"%lu pages", (unsigned long)liveView.document.pageCount]);
    check("and the title bar follows", [liveView.window.subtitle isEqualToString:@"2 pages"],
          liveView.window.subtitle);
    [live close];

    NSString *junk = [dir stringByAppendingPathComponent:@"junk.pdf"];
    [@"this is not a pdf" writeToFile:junk atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    err = nil;
    NSDocument *bad = openDoc([NSURL fileURLWithPath:junk], &err);
    check("a damaged PDF says so instead of opening", bad == nil && err != nil, err.localizedDescription);

    NSString *locked = [dir stringByAppendingPathComponent:@"locked.pdf"];
    writePdf(locked, @"secret");
    err = nil;
    NSDocument *lockedDoc = openDoc([NSURL fileURLWithPath:locked], &err);
    PDFView *lockedView = [lockedDoc valueForKey:@"pdfView"];
    check("a locked PDF opens, still locked", lockedView.document.isLocked, err.localizedDescription ?: @"");
    check("and shows it needs a password",
          [lockedView.window.subtitle isEqualToString:@"Locked"], lockedView.window.subtitle);
    [lockedDoc close];
}

// A book, stored rather than compressed: inflating is tested in the page suites,
// and what is being tested here is the seam between the app and the page.
static NSData *zipOf(NSArray<NSArray<NSString *> *> *files) {
    NSMutableData *body = [NSMutableData data], *directory = [NSMutableData data];
    void (^u16)(NSMutableData *, uint16_t) = ^(NSMutableData *d, uint16_t v) { [d appendBytes:&v length:2]; };
    void (^u32)(NSMutableData *, uint32_t) = ^(NSMutableData *d, uint32_t v) { [d appendBytes:&v length:4]; };
    for (NSArray<NSString *> *file in files) {
        NSData *name = [file[0] dataUsingEncoding:NSUTF8StringEncoding];
        NSData *data = [file[1] dataUsingEncoding:NSUTF8StringEncoding];
        uint32_t at = (uint32_t)body.length;
        void (^sizes)(NSMutableData *) = ^(NSMutableData *d) {
            u32(d, 0); u32(d, (uint32_t)data.length); u32(d, (uint32_t)data.length);
            u16(d, (uint16_t)name.length); u16(d, 0);
        };
        u32(body, 0x04034b50); u16(body, 20); u16(body, 0); u16(body, 0); u32(body, 0);
        sizes(body); [body appendData:name]; [body appendData:data];
        u32(directory, 0x02014b50); u16(directory, 20); u16(directory, 20); u16(directory, 0);
        u16(directory, 0); u32(directory, 0); sizes(directory);
        u16(directory, 0); u16(directory, 0); u16(directory, 0); u32(directory, 0); u32(directory, at);
        [directory appendData:name];
    }
    NSMutableData *out = [body mutableCopy];
    uint32_t start = (uint32_t)out.length;
    [out appendData:directory];
    u32(out, 0x06054b50); u16(out, 0); u16(out, 0); u16(out, (uint16_t)files.count);
    u16(out, (uint16_t)files.count); u32(out, (uint32_t)directory.length); u32(out, start); u16(out, 0);
    return out;
}

static NSString *inPage(WKWebView *web, NSString *src) {
    __block NSString *out = nil;
    __block BOOL done = NO;
    [web evaluateJavaScript:src completionHandler:^(id r, NSError *e) {
        out = e ? nil : [NSString stringWithFormat:@"%@", r];
        done = YES;
    }];
    pump(5, ^BOOL{ return done; });
    return out ?: @"";
}

static void book(NSString *dir) {
    NSString *page = @"<html xmlns=\"http://www.w3.org/1999/xhtml\"><body><p>%@</p>"
                     @"<a href=\"https://example.com/\">web</a> <a href=\"file:///etc/hosts\">file</a>"
                     @"<script>window.__booked = 1</script></body></html>";
    NSData *zip = zipOf(@[
        @[@"META-INF/container.xml", @"<container><rootfiles><rootfile full-path=\"a.opf\"/></rootfiles></container>"],
        @[@"a.opf", @"<package xmlns:dc=\"purl\"><metadata><dc:title>A Mac Book</dc:title><dc:creator>A. Writer</dc:creator></metadata>"
                    @"<manifest><item id=\"1\" href=\"1.xhtml\" media-type=\"application/xhtml+xml\"/>"
                    @"<item id=\"2\" href=\"2.xhtml\" media-type=\"application/xhtml+xml\"/></manifest>"
                    @"<spine><itemref idref=\"1\"/><itemref idref=\"2\"/></spine></package>"],
        @[@"1.xhtml", [NSString stringWithFormat:page, @"The first chapter."]],
        @[@"2.xhtml", [NSString stringWithFormat:page, @"The second chapter."]],
    ]);
    NSString *path = [dir stringByAppendingPathComponent:@"book.epub"];
    [zip writeToFile:path atomically:YES];

    NSError *err = nil;
    NSDocument *doc = openDoc([NSURL fileURLWithPath:path], &err);
    check("a book opens", doc != nil, err.localizedDescription ?: @"");
    check("as a book document", [doc isKindOfClass:NSClassFromString(@"GlyphBookDocument")],
          NSStringFromClass(doc.class));
    WKWebView *web = [doc valueForKey:@"webView"];
    NSString *textNow = @"(document.querySelector('.glyph-book-text') || {}).innerText";
    pump(15, ^BOOL{ return [inPage(web, textNow) containsString:@"The first chapter"]; });
    check("its first chapter is on screen", [inPage(web, textNow) containsString:@"The first chapter"], inPage(web, textNow));
    pump(2, ^BOOL{ return [web.window.title isEqualToString:@"A Mac Book"]; });
    check("the title bar shows the book", [web.window.title isEqualToString:@"A Mac Book"], web.window.title);
    check("and its author", [web.window.subtitle isEqualToString:@"A. Writer"], web.window.subtitle);
    NSData *held = [doc valueForKey:@"bytes"];
    pump(3.2, nil);
    check("a book is read once, then left alone", [doc valueForKey:@"bytes"] == held, @"");
    check("no script in it ran", [inPage(web, @"String(window.__booked)") isEqualToString:@"undefined"], @"");
    check("it counts as edited for nothing", !doc.isDocumentEdited, @"");
    NSMenuItem *saveItem = [[NSMenuItem alloc] initWithTitle:@"Save" action:@selector(saveDocument:)
                                               keyEquivalent:@""];
    check("Save is greyed out", ![(id<NSUserInterfaceValidations>)doc validateUserInterfaceItem:saveItem], @"");

    gOpened = 0;
    Method real = class_getInstanceMethod(NSWorkspace.class, @selector(openURL:));
    Method fake = class_getInstanceMethod(NSWorkspace.class, @selector(glyphTestOpenURL:));
    method_exchangeImplementations(real, fake);
    inPage(web, @"document.querySelector('.glyph-book-text a[href^=\"https\"]').click(); 1");
    pump(5, ^BOOL{ return gOpened == 1; });
    check("a web link opens", gOpened == 1, @"");
    inPage(web, @"postToApp({ type: 'openURL', url: 'file:///System/Applications/Calculator.app' }); 1");
    inPage(web, @"postToApp({ type: 'openURL', url: 'x-apple.systempreferences:foo' }); 1");
    pump(1, nil);
    check("a link to a file or an app does nothing", gOpened == 1,
          [NSString stringWithFormat:@"%ld opened", (long)gOpened]);
    method_exchangeImplementations(real, fake);

    NSString *next = @"[...document.querySelectorAll('.glyph-book-button')].find((b) => b.textContent === 'Next').click(); 1";
    inPage(web, next);
    pump(5, ^BOOL{ return [inPage(web, textNow) containsString:@"The second chapter"]; });
    check("Next turns the page", [inPage(web, textNow) containsString:@"The second chapter"], @"");
    NSString *sepia = @"[...document.querySelectorAll('.glyph-book-panel button')].find((b) => b.textContent === 'Sepia').click(); 1";
    inPage(web, sepia);
    pump(0.8, nil);
    [doc close];
    pump(0.5, nil);

    NSDocument *again = openDoc([NSURL fileURLWithPath:path], NULL);
    WKWebView *web2 = [again valueForKey:@"webView"];
    pump(15, ^BOOL{ return [inPage(web2, textNow) containsString:@"chapter"]; });
    check("it reopens at the same chapter", [inPage(web2, textNow) containsString:@"The second chapter"], inPage(web2, textNow));
    check("with the same settings",
          [inPage(web2, @"document.querySelector('.glyph-book').dataset.page") isEqualToString:@"sepia"], @"");
    [again close];
    check("the book is byte for byte what it was", [[NSData dataWithContentsOfFile:path] isEqual:zip], @"");

    NSString *junk = [dir stringByAppendingPathComponent:@"junk.epub"];
    [@"this is not a book" writeToFile:junk atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    err = nil;
    NSDocument *bad = openDoc([NSURL fileURLWithPath:junk], &err);
    check("a damaged book says so instead of opening", bad == nil && err != nil, err.localizedDescription);

    NSString *wrong = [dir stringByAppendingPathComponent:@"wrong.epub"];
    [zipOf(@[@[@"hello.txt", @"a zip, but not a book"]]) writeToFile:wrong atomically:YES];
    NSDocument *zipOnly = openDoc([NSURL fileURLWithPath:wrong], NULL);
    WKWebView *web3 = [zipOnly valueForKey:@"webView"];
    NSString *note = @"(document.querySelector('.glyph-book-error') || {}).textContent";
    pump(10, ^BOOL{ return [inPage(web3, note) containsString:@"book"]; });
    check("a zip that isn't a book says so on the page", [inPage(web3, note) containsString:@"readable book"], inPage(web3, note));
    [zipOnly close];
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        [NSApp finishLaunching];
        NSString *dir = [NSTemporaryDirectory() stringByAppendingPathComponent:
                         [[NSUUID UUID] UUIDString]];
        [NSFileManager.defaultManager createDirectoryAtPath:dir withIntermediateDirectories:YES
                                                 attributes:nil error:NULL];
        printf("doc-smoke (the Mac app's documents):\n");
        readOnlyNote(dir);
        pdf(dir);
        book(dir);
        [NSFileManager.defaultManager removeItemAtPath:dir error:NULL];
        printf(gFails ? "\n%d FAILURE(S)\n" : "\nall pass\n", gFails);
        fflush(stdout);
        _exit(gFails ? 1 : 0);
    }
}
