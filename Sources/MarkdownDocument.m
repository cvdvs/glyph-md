#import "MarkdownDocument.h"
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import "GlyphTheme.h"
#import "GlyphHighlighter.h"
#import "GlyphGutter.h"

static NSColor *DynamicColor(CGFloat lr, CGFloat lg, CGFloat lb,
                             CGFloat dr, CGFloat dg, CGFloat db) {
    return [NSColor colorWithName:nil
                  dynamicProvider:^NSColor *(NSAppearance *appearance) {
        NSAppearanceName match = [appearance bestMatchFromAppearancesWithNames:
                                  @[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
        if ([match isEqualToString:NSAppearanceNameDarkAqua]) {
            return [NSColor colorWithSRGBRed:dr green:dg blue:db alpha:1];
        }
        return [NSColor colorWithSRGBRed:lr green:lg blue:lb alpha:1];
    }];
}

static NSColor *PageBackgroundColor(void) {
    return DynamicColor(1.0, 1.0, 1.0, 0.118, 0.118, 0.149);       // #ffffff / #1e1e26
}

static NSColor *EditorTextColor(void) {
    return DynamicColor(0.149, 0.153, 0.169, 0.847, 0.855, 0.871); // #26272b / #d8dade
}

// A document is untrusted input, so a link inside one must never be able to hand
// the system an arbitrary URL. NSWorkspace happily launches other applications
// via custom schemes and can act on file:// paths; only ordinary web and mail
// links are worth opening on a user's behalf.
static BOOL GlyphURLIsSafeToOpen(NSURL *url) {
    if (!url) return NO;
    NSString *scheme = url.scheme.lowercaseString;
    if (!scheme) return NO;
    return [scheme isEqualToString:@"http"] ||
           [scheme isEqualToString:@"https"] ||
           [scheme isEqualToString:@"mailto"];
}

// Lets the first click on an unfocused window reach the page instead of only
// bringing the window forward — so click-to-edit works on the very first click.
@interface GlyphWebView : WKWebView
@end

@implementation GlyphWebView
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
@end

// WKUserContentController retains its handler; this keeps the document out of the cycle.
@interface GlyphScriptProxy : NSObject <WKScriptMessageHandler>
@property (nonatomic, weak) id<WKScriptMessageHandler> target;
@end

@implementation GlyphScriptProxy
- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
    [self.target userContentController:userContentController didReceiveScriptMessage:message];
}
@end

@interface MarkdownDocument () <WKScriptMessageHandler>
@property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, strong) NSScrollView *scrollView;
@property (nonatomic, strong) NSTextView *textView;
@property (nonatomic, strong) GlyphHighlighter *highlighter;
@property (nonatomic, strong) GlyphGutter *gutter;
@property (nonatomic, strong) NSView *formatBar;
@property (nonatomic, strong) NSTextField *countLabel;
@property (nonatomic, strong) NSToolbarItem *toggleItem;
@property (nonatomic, assign) BOOL editing;
@property (nonatomic, assign) BOOL pageReady;
@end

@implementation MarkdownDocument

- (instancetype)init {
    self = [super init];
    if (self) {
        _text = @"";
    }
    return self;
}

+ (BOOL)autosavesInPlace { return YES; }
+ (BOOL)canConcurrentlyReadDocumentsOfType:(NSString *)typeName { return NO; }

#pragma mark - Reading and writing

- (NSData *)dataOfType:(NSString *)typeName error:(NSError **)outError {
    NSString *current = self.textView ? self.textView.string : self.text;
    return [(current ?: @"") dataUsingEncoding:NSUTF8StringEncoding];
}

- (BOOL)readFromData:(NSData *)data ofType:(NSString *)typeName error:(NSError **)outError {
    NSString *s = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (!s) s = [[NSString alloc] initWithData:data encoding:NSUnicodeStringEncoding];
    if (!s) s = [[NSString alloc] initWithData:data encoding:NSISOLatin1StringEncoding];
    self.text = s ?: @"";
    if (self.windowControllers.count > 0) {
        dispatch_async(dispatch_get_main_queue(), ^{ [self refreshUIFromText]; });
    }
    return YES;
}

- (void)refreshUIFromText {
    if (self.textView && ![self.textView.string isEqualToString:self.text]) {
        [self setRawText:self.text];
    }
    [self renderMarkdown];
    [self updateWordCount];
}

// When the file moves (first save, Save As), reload the template so relative
// image paths resolve against the new folder.
- (void)setFileURL:(NSURL *)fileURL {
    NSURL *oldBase = self.fileURL.URLByDeletingLastPathComponent;
    [super setFileURL:fileURL];
    NSURL *newBase = fileURL.URLByDeletingLastPathComponent;
    if (self.webView && newBase && ![newBase isEqual:oldBase]) {
        [self loadTemplateHTML];
    }
}

#pragma mark - Window

- (void)makeWindowControllers {
    NSRect frame = NSMakeRect(0, 0, 940, 800);
    NSWindow *window = [[NSWindow alloc]
        initWithContentRect:frame
                  styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                             NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable)
                    backing:NSBackingStoreBuffered
                      defer:YES];
    window.releasedWhenClosed = NO;
    window.minSize = NSMakeSize(480, 360);
    window.backgroundColor = PageBackgroundColor();
    // Every document joins the front window as a tab, like a browser / PDF viewer.
    window.tabbingIdentifier = @"glyph";
    window.tabbingMode = NSWindowTabbingModePreferred;
    if (@available(macOS 11.0, *)) {
        window.toolbarStyle = NSWindowToolbarStyleUnified;
    }
    [window center];

    NSToolbar *toolbar = [[NSToolbar alloc] initWithIdentifier:@"glyph-toolbar"];
    toolbar.delegate = self;
    toolbar.displayMode = NSToolbarDisplayModeIconOnly;
    toolbar.allowsUserCustomization = NO;
    window.toolbar = toolbar;

    NSView *content = [[NSView alloc] initWithFrame:frame];
    CGFloat barHeight = 42;

    // Reading pane
    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    // Lets the rendered page load images that sit next to the .md file on disk.
    @try {
        [config.preferences setValue:@YES forKey:@"allowFileAccessFromFileURLs"];
    } @catch (NSException *e) {}
    GlyphScriptProxy *proxy = [[GlyphScriptProxy alloc] init];
    proxy.target = self;
    [config.userContentController addScriptMessageHandler:proxy name:@"glyph"];
    self.webView = [[GlyphWebView alloc] initWithFrame:
        NSMakeRect(0, 0, NSWidth(content.bounds), NSHeight(content.bounds) - barHeight)
                                          configuration:config];
    self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.webView.navigationDelegate = self;
    @try {
        [self.webView setValue:@NO forKey:@"drawsBackground"];
    } @catch (NSException *e) {}
    [content addSubview:self.webView];

    // Formatting bar (edit mode only)
    self.formatBar = [self buildFormatBarWithFrame:
        NSMakeRect(0, NSHeight(content.bounds) - barHeight, NSWidth(content.bounds), barHeight)];
    self.formatBar.autoresizingMask = NSViewWidthSizable | NSViewMinYMargin;
    [content addSubview:self.formatBar];

    // Editing pane
    self.scrollView = [[NSScrollView alloc] initWithFrame:
        NSMakeRect(0, 0, NSWidth(content.bounds), NSHeight(content.bounds) - barHeight)];
    self.scrollView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.scrollView.hasVerticalScroller = YES;
    self.scrollView.drawsBackground = NO;

    NSTextStorage *storage = [[NSTextStorage alloc] init];
    NSLayoutManager *lm = [[NSLayoutManager alloc] init];
    // Lays out only what is asked for, so a 30,000-word file does not pay for
    // laying out everything above the visible rect on every gutter draw.
    lm.allowsNonContiguousLayout = YES;
    [storage addLayoutManager:lm];
    NSTextContainer *tc = [[NSTextContainer alloc]
        initWithContainerSize:NSMakeSize(NSWidth(self.scrollView.bounds), FLT_MAX)];
    [lm addTextContainer:tc];
    GlyphTextView *tv = [[GlyphTextView alloc] initWithFrame:self.scrollView.bounds
                                              textContainer:tc];
    tv.minSize = NSMakeSize(0, 0);
    tv.maxSize = NSMakeSize(FLT_MAX, FLT_MAX);
    tv.verticallyResizable = YES;
    tv.horizontallyResizable = NO;
    tv.autoresizingMask = NSViewWidthSizable;
    tv.textContainer.widthTracksTextView = YES;
    tv.richText = NO;
    tv.allowsUndo = YES;
    tv.usesFindBar = YES;
    tv.automaticQuoteSubstitutionEnabled = NO;
    tv.automaticDashSubstitutionEnabled = NO;
    tv.automaticTextReplacementEnabled = NO;
    tv.automaticSpellingCorrectionEnabled = NO;
    tv.textContainerInset = NSMakeSize(24, 18);
    tv.backgroundColor = PageBackgroundColor();
    tv.drawsBackground = YES;
    tv.insertionPointColor = GlyphAccent();
    tv.font = GlyphMonoFont();
    tv.textColor = GlyphFG();
    tv.defaultParagraphStyle = GlyphBaseParagraphStyle();
    tv.delegate = self;
    tv.string = self.text ?: @"";
    self.textView = tv;
    self.highlighter = [[GlyphHighlighter alloc] initWithTextView:tv];
    self.scrollView.documentView = tv;
    // The ruler must be installed after documentView, or it attaches with a nil
    // clientView and draws an empty strip.
    self.gutter = [[GlyphGutter alloc] initWithHighlighter:self.highlighter];
    tv.gutter = self.gutter;
    [tv syncGutterInset];
    [content addSubview:self.scrollView];

    // Word count
    NSTextField *label = [NSTextField labelWithString:@""];
    label.font = [NSFont monospacedDigitSystemFontOfSize:11 weight:NSFontWeightRegular];
    label.textColor = [NSColor secondaryLabelColor];
    self.countLabel = label;
    [content addSubview:label];

    window.contentView = content;

    NSWindowController *wc = [[NSWindowController alloc] initWithWindow:window];
    [self addWindowController:wc];

    // Join the front Glyph window as a tab; then make sure the tab bar is showing
    // even for the first window, so tabs are visible from the start.
    NSWindow *anchor = nil;
    for (NSWindow *w in NSApp.orderedWindows) {
        if (w != window && w.isVisible && [w.tabbingIdentifier isEqualToString:@"glyph"]) {
            anchor = w;
            break;
        }
    }
    if (anchor) {
        [anchor addTabbedWindow:window ordered:NSWindowAbove];
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        if (window.tabGroup && !window.tabGroup.tabBarVisible) {
            [window toggleTabBar:nil];
        }
    });

    self.editing = (self.text.length == 0);
    [self loadTemplateHTML];
    [self applyMode];
    [self updateWordCount];
}

- (void)setRawText:(NSString *)s {
    if (!self.textView) return;
    [self.highlighter beginBulkReplace];
    self.textView.string = s ?: @"";
    [self.highlighter endBulkReplace];
    [self refreshGutter];
}

// Widen the left margin when the line count gains a digit, and repaint the numbers.
- (void)refreshGutter {
    if ([self.gutter updateWidth]) {
        [(GlyphTextView *)self.textView syncGutterInset];
    }
    self.textView.needsDisplay = YES;
}

#pragma mark - Formatting bar

- (NSButton *)fmtButton:(NSString *)symbol title:(NSString *)title action:(SEL)action tip:(NSString *)tip {
    NSButton *b = nil;
    NSImage *img = nil;
    if (symbol) {
        if (@available(macOS 11.0, *)) {
            img = [NSImage imageWithSystemSymbolName:symbol accessibilityDescription:tip];
            NSImageSymbolConfiguration *cfg =
                [NSImageSymbolConfiguration configurationWithPointSize:15
                                                                weight:NSFontWeightMedium];
            img = [img imageWithSymbolConfiguration:cfg] ?: img;
        }
    }
    if (img) {
        b = [NSButton buttonWithImage:img target:self action:action];
    } else {
        b = [NSButton buttonWithTitle:(title ?: @"?") target:self action:action];
        b.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
    }
    b.bezelStyle = NSBezelStyleTexturedRounded;
    b.bordered = YES;
    b.showsBorderOnlyWhileMouseInside = YES;
    b.toolTip = tip;
    return b;
}

- (NSView *)buildFormatBarWithFrame:(NSRect)frame {
    NSView *bar = [[NSView alloc] initWithFrame:frame];

    NSButton *undo = [self fmtButton:@"arrow.uturn.backward" title:@"↩" action:@selector(fmtUndo:) tip:@"Undo (⌘Z)"];
    NSButton *redo = [self fmtButton:@"arrow.uturn.forward" title:@"↪" action:@selector(fmtRedo:) tip:@"Redo (⇧⌘Z)"];

    NSButton *h1 = [self fmtButton:nil title:@"H1" action:@selector(fmtH1:) tip:@"Heading 1 (⌘1)"];
    NSButton *h2 = [self fmtButton:nil title:@"H2" action:@selector(fmtH2:) tip:@"Heading 2 (⌘2)"];
    NSButton *h3 = [self fmtButton:nil title:@"H3" action:@selector(fmtH3:) tip:@"Heading 3 (⌘3)"];
    NSButton *bold = [self fmtButton:@"bold" title:@"B" action:@selector(fmtBold:) tip:@"Bold (⌘B)"];
    NSButton *italic = [self fmtButton:@"italic" title:@"I" action:@selector(fmtItalic:) tip:@"Italic (⌘I)"];
    NSButton *underline = [self fmtButton:@"underline" title:@"U" action:@selector(fmtUnderline:) tip:@"Underline (⌘U)"];
    NSButton *strike = [self fmtButton:@"strikethrough" title:@"S" action:@selector(fmtStrike:) tip:@"Strikethrough (⇧⌘X)"];
    NSButton *hl = [self fmtButton:@"highlighter" title:@"H" action:@selector(fmtHighlight:) tip:@"Highlight (⇧⌘H)"];
    NSButton *code = [self fmtButton:@"chevron.left.forwardslash.chevron.right" title:@"<>"
                              action:@selector(fmtCode:) tip:@"Inline code"];
    NSButton *link = [self fmtButton:@"link" title:@"Link" action:@selector(fmtLink:) tip:@"Link (⌘K)"];
    NSButton *image = [self fmtButton:@"photo" title:@"Img" action:@selector(fmtImage:)
                                  tip:@"Add picture — copies it next to the note"];
    NSButton *bullets = [self fmtButton:@"list.bullet" title:@"•" action:@selector(fmtBullets:) tip:@"Bullet list (⇧⌘8)"];
    NSButton *check = [self fmtButton:@"checklist" title:@"☑" action:@selector(fmtChecklist:) tip:@"Checklist (⇧⌘L)"];
    NSButton *quote = [self fmtButton:@"text.quote" title:@"❝" action:@selector(fmtQuote:) tip:@"Quote"];
    NSButton *callout = [self fmtButton:@"lightbulb" title:@"!" action:@selector(fmtCallout:) tip:@"Callout"];
    NSButton *table = [self fmtButton:@"tablecells" title:@"⊞" action:@selector(fmtTable:) tip:@"Table"];
    NSButton *codeblock = [self fmtButton:@"curlybraces" title:@"{}" action:@selector(fmtCodeBlock:) tip:@"Code block"];
    NSButton *eraser = [self fmtButton:@"eraser" title:@"⌫" action:@selector(fmtClearFormatting:)
                                   tip:@"Clear formatting from selection"];

    NSStackView *stack = [[NSStackView alloc] initWithFrame:bar.bounds];
    stack.translatesAutoresizingMaskIntoConstraints = YES;
    stack.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    stack.alignment = NSLayoutAttributeCenterY;
    stack.spacing = 8;
    stack.edgeInsets = NSEdgeInsetsMake(0, 12, 0, 12);
    stack.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    NSArray<NSButton *> *buttons =
        @[undo, redo, h1, h2, h3, bold, italic, underline, strike, hl, code,
          link, image, bullets, check, quote, callout, table, codeblock, eraser];
    for (NSButton *b in buttons) {
        [stack addView:b inGravity:NSStackViewGravityCenter];
    }
    [stack setCustomSpacing:20 afterView:redo];
    [stack setCustomSpacing:20 afterView:h3];
    [stack setCustomSpacing:20 afterView:code];
    [stack setCustomSpacing:20 afterView:image];
    [stack setCustomSpacing:20 afterView:codeblock];
    [bar addSubview:stack];

    NSBox *line = [[NSBox alloc] initWithFrame:NSMakeRect(0, 0, NSWidth(frame), 1)];
    line.boxType = NSBoxSeparator;
    line.autoresizingMask = NSViewWidthSizable;
    [bar addSubview:line];

    return bar;
}

#pragma mark - Toolbar

- (NSArray<NSToolbarItemIdentifier> *)toolbarDefaultItemIdentifiers:(NSToolbar *)toolbar {
    return @[NSToolbarFlexibleSpaceItemIdentifier, @"toggle"];
}

- (NSArray<NSToolbarItemIdentifier> *)toolbarAllowedItemIdentifiers:(NSToolbar *)toolbar {
    return @[NSToolbarFlexibleSpaceItemIdentifier, @"toggle"];
}

- (NSToolbarItem *)toolbar:(NSToolbar *)toolbar
     itemForItemIdentifier:(NSToolbarItemIdentifier)itemIdentifier
 willBeInsertedIntoToolbar:(BOOL)flag {
    if (![itemIdentifier isEqualToString:@"toggle"]) return nil;
    NSToolbarItem *item = [[NSToolbarItem alloc] initWithItemIdentifier:itemIdentifier];
    item.label = @"Edit";
    item.toolTip = @"Toggle reading / editing (⌘E)";
    if (@available(macOS 10.15, *)) {
        item.bordered = YES;
    }
    item.target = self;
    item.action = @selector(toggleEditMode:);
    self.toggleItem = item;
    [self updateToggleAppearance];
    return item;
}

- (void)updateToggleAppearance {
    NSString *symbol = self.editing ? @"book" : @"square.and.pencil";
    NSString *label = self.editing ? @"Read" : @"Edit";
    if (@available(macOS 11.0, *)) {
        self.toggleItem.image = [NSImage imageWithSystemSymbolName:symbol
                                          accessibilityDescription:label];
    }
    self.toggleItem.label = label;
}

#pragma mark - Mode switching

- (void)toggleEditMode:(id)sender {
    if (!self.editing) {
        // Entering raw mode: flush any pending live-preview edits first.
        [self.webView evaluateJavaScript:@"window.glyphFlush && window.glyphFlush()"
                       completionHandler:nil];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.08 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            self.editing = YES;
            [self applyMode];
        });
        return;
    }
    self.editing = NO;
    [self applyMode];
}

- (void)applyMode {
    self.formatBar.hidden = NO;
    if (self.editing) {
        if (self.textView && ![self.textView.string isEqualToString:self.text ?: @""]) {
            [self setRawText:self.text];
        }
        // Coloring only happens while the raw view is on screen. Typing in the
        // formatted view syncs text into this storage constantly, and highlighting
        // text nobody is looking at is pure cost.
        self.highlighter.enabled = YES;
        [self refreshGutter];
        self.webView.hidden = YES;
        self.scrollView.hidden = NO;
        [self.textView.window makeFirstResponder:self.textView];
    } else {
        self.text = [self.textView.string copy];
        self.highlighter.enabled = NO;
        [self renderMarkdown];
        self.scrollView.hidden = YES;
        self.webView.hidden = NO;
        [self.webView.window makeFirstResponder:self.webView];
    }
    [self updateToggleAppearance];
    [self updateWordCount];
}

// Menu-driven save while live-editing the preview: flush the page first.
- (void)saveDocument:(id)sender {
    if (!self.editing && self.webView) {
        [self.webView evaluateJavaScript:@"window.glyphFlush && window.glyphFlush()"
                       completionHandler:nil];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.08 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            [super saveDocument:sender];
        });
        return;
    }
    [super saveDocument:sender];
}

- (BOOL)validateUserInterfaceItem:(id<NSValidatedUserInterfaceItem>)item {
    SEL a = item.action;
    if (a == @selector(toggleEditMode:)) {
        if ([(id)item isKindOfClass:[NSMenuItem class]]) {
            ((NSMenuItem *)item).title = self.editing ? @"Reading View" : @"Edit";
        }
        return YES;
    }
    if (a == @selector(fmtH1:) || a == @selector(fmtH2:) || a == @selector(fmtH3:) ||
        a == @selector(fmtBold:) || a == @selector(fmtItalic:) || a == @selector(fmtUnderline:) ||
        a == @selector(fmtStrike:) || a == @selector(fmtHighlight:) || a == @selector(fmtCode:) ||
        a == @selector(fmtLink:) || a == @selector(fmtImage:) || a == @selector(fmtBullets:) ||
        a == @selector(fmtChecklist:) || a == @selector(fmtQuote:) || a == @selector(fmtCallout:) ||
        a == @selector(fmtTable:) || a == @selector(fmtCodeBlock:) ||
        a == @selector(fmtClearFormatting:) || a == @selector(fmtUndo:) ||
        a == @selector(fmtRedo:)) {
        return YES;
    }
    return [super validateUserInterfaceItem:item];
}

#pragma mark - Formatting actions

// In raw mode the actions edit the text view; in the live preview they run
// the matching command inside the page.
- (void)previewCommand:(NSString *)cmd {
    NSString *js = [NSString stringWithFormat:
        @"window.glyphToolbar && window.glyphToolbar('%@')", cmd];
    [self.webView evaluateJavaScript:js completionHandler:nil];
    [self.webView.window makeFirstResponder:self.webView];
}

- (void)fmtH1:(id)sender { self.editing ? [self applyHeadingLevel:1] : [self previewCommand:@"h1"]; }
- (void)fmtH2:(id)sender { self.editing ? [self applyHeadingLevel:2] : [self previewCommand:@"h2"]; }
- (void)fmtH3:(id)sender { self.editing ? [self applyHeadingLevel:3] : [self previewCommand:@"h3"]; }
- (void)fmtBold:(id)sender {
    self.editing ? [self toggleWrapPrefix:@"**" suffix:@"**" placeholder:@"bold"]
                 : [self previewCommand:@"bold"];
}
- (void)fmtItalic:(id)sender {
    self.editing ? [self toggleWrapPrefix:@"*" suffix:@"*" placeholder:@"italic"]
                 : [self previewCommand:@"italic"];
}
- (void)fmtUnderline:(id)sender {
    self.editing ? [self toggleWrapPrefix:@"<u>" suffix:@"</u>" placeholder:@"underlined"]
                 : [self previewCommand:@"underline"];
}
- (void)fmtStrike:(id)sender {
    self.editing ? [self toggleWrapPrefix:@"~~" suffix:@"~~" placeholder:@"struck"]
                 : [self previewCommand:@"strike"];
}
- (void)fmtHighlight:(id)sender {
    self.editing ? [self toggleWrapPrefix:@"==" suffix:@"==" placeholder:@"highlight"]
                 : [self previewCommand:@"highlight"];
}
- (void)fmtCode:(id)sender {
    self.editing ? [self toggleWrapPrefix:@"`" suffix:@"`" placeholder:@"code"]
                 : [self previewCommand:@"code"];
}
- (void)fmtBullets:(id)sender {
    self.editing ? [self toggleLinePrefix:@"- "] : [self previewCommand:@"bullets"];
}
- (void)fmtChecklist:(id)sender {
    self.editing ? [self toggleLinePrefix:@"- [ ] "] : [self previewCommand:@"checklist"];
}
- (void)fmtQuote:(id)sender {
    self.editing ? [self toggleLinePrefix:@"> "] : [self previewCommand:@"quote"];
}
- (void)fmtUndo:(id)sender {
    self.editing ? [self.undoManager undo] : [self previewCommand:@"undo"];
}
- (void)fmtRedo:(id)sender {
    self.editing ? [self.undoManager redo] : [self previewCommand:@"redo"];
}

- (void)fmtLink:(id)sender {
    if (!self.editing) { [self previewCommand:@"link"]; return; }
    NSTextView *tv = self.textView;
    if (!tv) return;
    NSRange sel = tv.selectedRange;
    NSString *selected = sel.length ? [tv.string substringWithRange:sel] : @"";
    if ([selected hasPrefix:@"http://"] || [selected hasPrefix:@"https://"]) {
        NSString *out = [NSString stringWithFormat:@"[text](%@)", selected];
        [tv insertText:out replacementRange:sel];
        tv.selectedRange = NSMakeRange(sel.location + 1, 4);
        return;
    }
    NSString *core = selected.length ? selected : @"link text";
    NSString *out = [NSString stringWithFormat:@"[%@](url)", core];
    [tv insertText:out replacementRange:sel];
    tv.selectedRange = NSMakeRange(sel.location + 1 + core.length + 2, 3);
}

- (void)fmtCallout:(id)sender {
    if (!self.editing) { [self previewCommand:@"callout"]; return; }
    NSRange r = [self insertBlockSnippet:@"> [!tip]- Title\n> Text\n"];
    if (r.location != NSNotFound) self.textView.selectedRange = NSMakeRange(r.location + 10, 5);
}

- (void)fmtTable:(id)sender {
    if (!self.editing) { [self previewCommand:@"table"]; return; }
    [self insertBlockSnippet:@"| Column | Column |\n| --- | --- |\n| Cell | Cell |\n"];
}

- (void)fmtCodeBlock:(id)sender {
    if (!self.editing) { [self previewCommand:@"codeblock"]; return; }
    NSTextView *tv = self.textView;
    if (!tv) return;
    NSRange sel = tv.selectedRange;
    NSString *body = sel.length ? [tv.string substringWithRange:sel] : @"code";
    if (![body hasSuffix:@"\n"]) body = [body stringByAppendingString:@"\n"];
    NSString *lead = @"";
    if (sel.location > 0 && [tv.string characterAtIndex:sel.location - 1] != '\n') lead = @"\n";
    NSString *out = [NSString stringWithFormat:@"%@```\n%@```\n", lead, body];
    [tv insertText:out replacementRange:sel];
}

- (void)fmtClearFormatting:(id)sender {
    if (!self.editing) { [self previewCommand:@"eraser"]; return; }
    NSTextView *tv = self.textView;
    if (!tv || tv.selectedRange.length == 0) return;
    NSRange sel = tv.selectedRange;
    NSString *s = [tv.string substringWithRange:sel];
    for (NSString *marker in @[@"**", @"~~", @"==", @"`", @"<u>", @"</u>", @"*"]) {
        s = [s stringByReplacingOccurrencesOfString:marker withString:@""];
    }
    NSRegularExpression *linkRe =
        [NSRegularExpression regularExpressionWithPattern:@"\\[([^\\]]*)\\]\\([^)]*\\)"
                                                  options:0 error:NULL];
    s = [linkRe stringByReplacingMatchesInString:s options:0
                                           range:NSMakeRange(0, s.length)
                                    withTemplate:@"$1"];
    [tv insertText:s replacementRange:sel];
    tv.selectedRange = NSMakeRange(sel.location, s.length);
}

- (void)fmtImage:(id)sender {
    NSWindow *window = self.windowForSheet;
    if (!window) return;
    if (!self.fileURL) {
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = @"Save this note first";
        alert.informativeText = @"Pictures get copied next to the note's file, so the note "
                                @"needs a home on disk. Press ⌘S, then try again.";
        [alert addButtonWithTitle:@"OK"];
        [alert beginSheetModalForWindow:window completionHandler:nil];
        return;
    }
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.canChooseFiles = YES;
    panel.canChooseDirectories = NO;
    panel.allowsMultipleSelection = NO;
    panel.allowedContentTypes = @[UTTypeImage];
    panel.message = @"The picture is copied next to the note and linked from it.";
    [panel beginSheetModalForWindow:window completionHandler:^(NSModalResponse response) {
        if (response != NSModalResponseOK || !panel.URL) return;
        [self insertImageFromURL:panel.URL];
    }];
}

- (void)insertImageFromURL:(NSURL *)src {
    NSURL *folder = self.fileURL.URLByDeletingLastPathComponent;
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *folderPath = folder.URLByStandardizingPath.path;
    NSString *srcPath = src.URLByStandardizingPath.path;
    NSString *relative;

    if ([srcPath hasPrefix:[folderPath stringByAppendingString:@"/"]]) {
        relative = [srcPath substringFromIndex:folderPath.length + 1];
    } else {
        NSString *name = src.lastPathComponent;
        NSString *base = name.stringByDeletingPathExtension;
        NSString *ext = name.pathExtension;
        NSURL *dest = [folder URLByAppendingPathComponent:name];
        NSInteger n = 2;
        while ([fm fileExistsAtPath:dest.path] &&
               ![fm contentsEqualAtPath:srcPath andPath:dest.path]) {
            name = [NSString stringWithFormat:@"%@-%ld.%@", base, (long)n++, ext];
            dest = [folder URLByAppendingPathComponent:name];
        }
        if (![fm fileExistsAtPath:dest.path]) {
            NSError *err = nil;
            if (![fm copyItemAtURL:src toURL:dest error:&err]) {
                [self presentError:err];
                return;
            }
        }
        relative = name;
    }

    NSString *encoded = [relative stringByAddingPercentEncodingWithAllowedCharacters:
                         NSCharacterSet.URLPathAllowedCharacterSet] ?: relative;
    if (self.editing) {
        NSString *md = [NSString stringWithFormat:@"![](%@)", encoded];
        [self.textView insertText:md replacementRange:self.textView.selectedRange];
    } else {
        NSData *json = [NSJSONSerialization dataWithJSONObject:@[encoded] options:0 error:NULL];
        NSString *arr = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
        NSString *js = [NSString stringWithFormat:
            @"window.glyphInsertImage && window.glyphInsertImage(%@[0])", arr];
        [self.webView evaluateJavaScript:js completionHandler:nil];
    }
}

#pragma mark - Formatting helpers

- (void)toggleWrapPrefix:(NSString *)pre suffix:(NSString *)suf placeholder:(NSString *)ph {
    NSTextView *tv = self.textView;
    if (!self.editing || !tv) return;
    NSRange sel = tv.selectedRange;
    NSString *s = tv.string;
    NSString *selected = sel.length ? [s substringWithRange:sel] : @"";
    NSUInteger m1 = pre.length, m2 = suf.length;

    // Selection includes the markers → unwrap.
    if (sel.length >= m1 + m2 && [selected hasPrefix:pre] && [selected hasSuffix:suf]) {
        NSString *inner = [selected substringWithRange:
                           NSMakeRange(m1, selected.length - m1 - m2)];
        [tv insertText:inner replacementRange:sel];
        tv.selectedRange = NSMakeRange(sel.location, inner.length);
        return;
    }
    // Markers sit just outside the selection → unwrap.
    if (sel.location >= m1 && sel.location + sel.length + m2 <= s.length) {
        NSString *before = [s substringWithRange:NSMakeRange(sel.location - m1, m1)];
        NSString *after = [s substringWithRange:NSMakeRange(sel.location + sel.length, m2)];
        if ([before isEqualToString:pre] && [after isEqualToString:suf]) {
            NSRange outer = NSMakeRange(sel.location - m1, sel.length + m1 + m2);
            [tv insertText:selected replacementRange:outer];
            tv.selectedRange = NSMakeRange(outer.location, selected.length);
            return;
        }
    }
    NSString *core = sel.length ? selected : ph;
    [tv insertText:[NSString stringWithFormat:@"%@%@%@", pre, core, suf]
   replacementRange:sel];
    tv.selectedRange = NSMakeRange(sel.location + m1, core.length);
}

- (void)applyHeadingLevel:(NSInteger)level {
    NSTextView *tv = self.textView;
    if (!self.editing || !tv) return;
    NSString *s = tv.string;
    NSRange lineRange = [s lineRangeForRange:tv.selectedRange];
    NSString *block = [s substringWithRange:lineRange];
    BOOL endsNL = [block hasSuffix:@"\n"];
    NSString *core = endsNL ? [block substringToIndex:block.length - 1] : block;
    NSArray<NSString *> *lines = [core componentsSeparatedByString:@"\n"];
    NSString *prefix = [@"" stringByPaddingToLength:level withString:@"#" startingAtIndex:0];

    BOOL allAtLevel = YES;
    NSMutableArray<NSString *> *bodies = [NSMutableArray array];
    for (NSString *line in lines) {
        NSUInteger hashes = 0;
        while (hashes < line.length && [line characterAtIndex:hashes] == '#') hashes++;
        NSString *rest = [line substringFromIndex:hashes];
        if (hashes > 0 && [rest hasPrefix:@" "]) rest = [rest substringFromIndex:1];
        if ((NSInteger)hashes != level) allAtLevel = NO;
        [bodies addObject:rest];
    }

    NSMutableArray<NSString *> *out = [NSMutableArray array];
    for (NSString *body in bodies) {
        if (allAtLevel) {
            [out addObject:body];
        } else {
            [out addObject:[NSString stringWithFormat:@"%@ %@", prefix, body]];
        }
    }
    NSString *joined = [out componentsJoinedByString:@"\n"];
    if (endsNL) joined = [joined stringByAppendingString:@"\n"];
    [tv insertText:joined replacementRange:lineRange];
}

- (void)toggleLinePrefix:(NSString *)prefix {
    NSTextView *tv = self.textView;
    if (!self.editing || !tv) return;
    NSString *s = tv.string;
    NSRange lineRange = [s lineRangeForRange:tv.selectedRange];
    NSString *block = [s substringWithRange:lineRange];
    BOOL endsNL = [block hasSuffix:@"\n"];
    NSString *core = endsNL ? [block substringToIndex:block.length - 1] : block;

    if (core.length == 0) {
        [tv insertText:prefix replacementRange:tv.selectedRange];
        return;
    }

    NSArray<NSString *> *lines = [core componentsSeparatedByString:@"\n"];
    BOOL allHave = YES;
    for (NSString *line in lines) {
        if (line.length && ![line hasPrefix:prefix]) { allHave = NO; break; }
    }
    NSMutableArray<NSString *> *out = [NSMutableArray array];
    for (NSString *line in lines) {
        if (allHave) {
            [out addObject:[line hasPrefix:prefix] ? [line substringFromIndex:prefix.length] : line];
        } else {
            [out addObject:line.length ? [prefix stringByAppendingString:line] : line];
        }
    }
    NSString *joined = [out componentsJoinedByString:@"\n"];
    if (endsNL) joined = [joined stringByAppendingString:@"\n"];
    [tv insertText:joined replacementRange:lineRange];
}

- (NSRange)insertBlockSnippet:(NSString *)snippet {
    NSTextView *tv = self.textView;
    if (!self.editing || !tv) return NSMakeRange(NSNotFound, 0);
    NSRange sel = tv.selectedRange;
    NSString *s = tv.string;
    NSString *lead = @"";
    if (sel.location > 0 && [s characterAtIndex:sel.location - 1] != '\n') lead = @"\n";
    [tv insertText:[lead stringByAppendingString:snippet] replacementRange:sel];
    return NSMakeRange(sel.location + lead.length, snippet.length);
}

#pragma mark - Edits arriving from the reading view

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
    if (![message.body isKindOfClass:[NSDictionary class]]) return;
    NSDictionary *body = message.body;
    NSString *type = body[@"type"];
    if ([type isEqualToString:@"source"]) {
        // The live preview serialized itself back to markdown after an edit.
        NSString *text = [body[@"text"] isKindOfClass:[NSString class]] ? body[@"text"] : nil;
        if (text) [self applySourceEdit:text];
    } else if ([type isEqualToString:@"openURL"]) {
        NSString *urlString = [body[@"url"] isKindOfClass:[NSString class]] ? body[@"url"] : nil;
        NSURL *url = urlString ? [NSURL URLWithString:urlString] : nil;
        if (GlyphURLIsSafeToOpen(url)) [[NSWorkspace sharedWorkspace] openURL:url];
    }
}

- (void)applySourceEdit:(NSString *)updated {
    [self applySourceEdit:updated rerender:NO];
}

// rerender:YES is the undo/redo path — there the reading view still shows the
// state being replaced. Edits arriving from the preview already show the new state.
- (void)applySourceEdit:(NSString *)updated rerender:(BOOL)rerender {
    NSString *old = self.text ?: @"";
    if ([old isEqualToString:updated]) return;
    [[self.undoManager prepareWithInvocationTarget:self] applySourceEdit:old rerender:YES];
    [self.undoManager setActionName:@"Edit"];
    self.text = updated;
    if (self.textView) [self setRawText:updated];
    if (rerender) [self renderMarkdown];
    [self updateWordCount];
}

#pragma mark - Rendering

+ (NSString *)viewerTemplate {
    static NSString *tpl;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSURL *htmlURL = [[NSBundle mainBundle] URLForResource:@"viewer" withExtension:@"html"];
        NSURL *jsURL = [[NSBundle mainBundle] URLForResource:@"marked.min" withExtension:@"js"];
        NSString *html = htmlURL ? [NSString stringWithContentsOfURL:htmlURL
                                                            encoding:NSUTF8StringEncoding
                                                               error:NULL] : nil;
        NSString *js = jsURL ? [NSString stringWithContentsOfURL:jsURL
                                                        encoding:NSUTF8StringEncoding
                                                           error:NULL] : nil;
        if (html && js) {
            html = [html stringByReplacingOccurrencesOfString:@"/*__MARKED_JS__*/" withString:js];
            html = [html stringByReplacingOccurrencesOfString:@"/*__INITIAL__*/" withString:@""];
            tpl = html;
        } else {
            tpl = @"<!doctype html><meta charset=utf-8><body style='font:14px -apple-system;"
                  @"padding:2em'>Glyph could not load its viewer resources.";
        }
    });
    return tpl;
}

- (void)loadTemplateHTML {
    self.pageReady = NO;
    NSURL *base = self.fileURL ? self.fileURL.URLByDeletingLastPathComponent : nil;
    [self.webView loadHTMLString:[MarkdownDocument viewerTemplate] baseURL:base];
}

- (void)renderMarkdown {
    if (!self.pageReady) return;
    NSString *t = self.text ?: @"";
    NSData *json = [NSJSONSerialization dataWithJSONObject:@[t] options:0 error:NULL];
    if (!json) return;
    NSString *arr = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    NSString *js = [NSString stringWithFormat:@"window.renderMarkdown(%@[0])", arr];
    [self.webView evaluateJavaScript:js completionHandler:nil];
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    self.pageReady = YES;
    [self renderMarkdown];
}

// Clicked links open in the system default app (browser for web links),
// never inside the reading pane.
- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = navigationAction.request.URL;
    if (navigationAction.navigationType == WKNavigationTypeLinkActivated) {
        if (GlyphURLIsSafeToOpen(url)) [[NSWorkspace sharedWorkspace] openURL:url];
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }
    // The page is loaded once with loadHTMLString and never navigates again.
    // Anything else — a form post, a meta refresh, a redirect a document tried to
    // trigger — is the document trying to leave, and leaving means exfiltration.
    BOOL isInitialLoad = !url || [url.scheme.lowercaseString isEqualToString:@"about"] ||
                         [url isFileURL];
    decisionHandler(isInitialLoad ? WKNavigationActionPolicyAllow
                                  : WKNavigationActionPolicyCancel);
}

#pragma mark - Text editing

- (NSUndoManager *)undoManagerForTextView:(NSTextView *)view {
    return self.undoManager;
}

- (void)textDidChange:(NSNotification *)notification {
    self.text = [self.textView.string copy];
    [self updateWordCount];
}

#pragma mark - Word count

- (void)updateWordCount {
    NSString *current = self.text ?: @"";
    __block NSUInteger words = 0;
    [current enumerateSubstringsInRange:NSMakeRange(0, current.length)
                                options:(NSStringEnumerationByWords | NSStringEnumerationSubstringNotRequired)
                             usingBlock:^(NSString *sub, NSRange r1, NSRange r2, BOOL *stop) {
        words++;
    }];
    NSNumberFormatter *fmt = [[NSNumberFormatter alloc] init];
    fmt.numberStyle = NSNumberFormatterDecimalStyle;
    self.countLabel.stringValue = [NSString stringWithFormat:@"%@ words",
                                   [fmt stringFromNumber:@(words)]];
    [self.countLabel sizeToFit];
    NSView *content = self.countLabel.superview;
    NSRect f = self.countLabel.frame;
    f.origin.x = NSWidth(content.bounds) - NSWidth(f) - 16;
    f.origin.y = 12;
    self.countLabel.frame = f;
    self.countLabel.autoresizingMask = NSViewMinXMargin | NSViewMaxYMargin;
}

@end
