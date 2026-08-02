#import <Cocoa/Cocoa.h>

static NSString * const kGlyphAppearanceKey = @"GlyphAppearance";

@interface GlyphAppDelegate : NSObject <NSApplicationDelegate>
@end

@implementation GlyphAppDelegate

- (void)applicationWillFinishLaunching:(NSNotification *)notification {
    [self applyAppearancePreference];
}

- (void)applyAppearancePreference {
    NSString *pref = [[NSUserDefaults standardUserDefaults] stringForKey:kGlyphAppearanceKey];
    if ([pref isEqualToString:@"light"]) {
        NSApp.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
    } else if ([pref isEqualToString:@"dark"]) {
        NSApp.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    } else {
        NSApp.appearance = nil;   // follow the system
    }
}

- (void)setAppearancePreference:(NSString *)pref {
    if (pref) {
        [[NSUserDefaults standardUserDefaults] setObject:pref forKey:kGlyphAppearanceKey];
    } else {
        [[NSUserDefaults standardUserDefaults] removeObjectForKey:kGlyphAppearanceKey];
    }
    [self applyAppearancePreference];
}

- (void)appearanceSystem:(id)sender { [self setAppearancePreference:nil]; }
- (void)appearanceLight:(id)sender { [self setAppearancePreference:@"light"]; }
- (void)appearanceDark:(id)sender { [self setAppearancePreference:@"dark"]; }

- (BOOL)validateMenuItem:(NSMenuItem *)menuItem {
    NSString *pref = [[NSUserDefaults standardUserDefaults] stringForKey:kGlyphAppearanceKey];
    if (menuItem.action == @selector(appearanceSystem:)) {
        menuItem.state = (pref == nil) ? NSControlStateValueOn : NSControlStateValueOff;
        return YES;
    }
    if (menuItem.action == @selector(appearanceLight:)) {
        menuItem.state = [pref isEqualToString:@"light"] ? NSControlStateValueOn : NSControlStateValueOff;
        return YES;
    }
    if (menuItem.action == @selector(appearanceDark:)) {
        menuItem.state = [pref isEqualToString:@"dark"] ? NSControlStateValueOn : NSControlStateValueOff;
        return YES;
    }
    return YES;
}

- (BOOL)applicationShouldOpenUntitledFile:(NSApplication *)sender {
    return YES;
}

- (BOOL)applicationSupportsSecureRestorableState:(NSApplication *)app {
    return YES;
}

// Backs the "+" button in the window tab bar: a new tab is a new untitled note.
- (void)newWindowForTab:(id)sender {
    [[NSDocumentController sharedDocumentController] newDocument:sender];
}

@end

static NSMenuItem *Item(NSString *title, SEL action, NSString *key, NSEventModifierFlags mods) {
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:action keyEquivalent:key];
    if (mods) item.keyEquivalentModifierMask = mods;
    return item;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        static GlyphAppDelegate *delegate;
        delegate = [[GlyphAppDelegate alloc] init];
        app.delegate = delegate;

        NSMenu *menubar = [[NSMenu alloc] init];

        // App menu
        NSMenuItem *appItem = [[NSMenuItem alloc] init];
        [menubar addItem:appItem];
        NSMenu *appMenu = [[NSMenu alloc] init];
        [appMenu addItem:Item(@"About Glyph", @selector(orderFrontStandardAboutPanel:), @"", 0)];
        [appMenu addItem:[NSMenuItem separatorItem]];
        [appMenu addItem:Item(@"Hide Glyph", @selector(hide:), @"h", 0)];
        [appMenu addItem:Item(@"Hide Others", @selector(hideOtherApplications:), @"h",
                              NSEventModifierFlagCommand | NSEventModifierFlagOption)];
        [appMenu addItem:Item(@"Show All", @selector(unhideAllApplications:), @"", 0)];
        [appMenu addItem:[NSMenuItem separatorItem]];
        [appMenu addItem:Item(@"Quit Glyph", @selector(terminate:), @"q", 0)];
        appItem.submenu = appMenu;

        // File menu
        NSMenuItem *fileItem = [[NSMenuItem alloc] init];
        [menubar addItem:fileItem];
        NSMenu *fileMenu = [[NSMenu alloc] initWithTitle:@"File"];
        [fileMenu addItem:Item(@"New Note", @selector(newDocument:), @"n", 0)];
        [fileMenu addItem:Item(@"Open…", @selector(openDocument:), @"o", 0)];

        NSMenuItem *recentItem = [[NSMenuItem alloc] initWithTitle:@"Open Recent"
                                                            action:nil
                                                     keyEquivalent:@""];
        NSMenu *recentMenu = [[NSMenu alloc] initWithTitle:@"Open Recent"];
        // Wires the standard Open Recent behavior in a nib-less app.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wundeclared-selector"
        if ([recentMenu respondsToSelector:@selector(_setMenuName:)]) {
            [recentMenu performSelector:@selector(_setMenuName:)
                             withObject:@"NSRecentDocumentsMenu"];
        }
#pragma clang diagnostic pop
        recentItem.submenu = recentMenu;
        [fileMenu addItem:recentItem];

        [fileMenu addItem:[NSMenuItem separatorItem]];
        [fileMenu addItem:Item(@"Close", @selector(performClose:), @"w", 0)];
        [fileMenu addItem:Item(@"Save", @selector(saveDocument:), @"s", 0)];
        [fileMenu addItem:Item(@"Save As…", @selector(saveDocumentAs:), @"s",
                               NSEventModifierFlagCommand | NSEventModifierFlagShift)];
        [fileMenu addItem:Item(@"Revert to Saved", @selector(revertDocumentToSaved:), @"", 0)];
        fileItem.submenu = fileMenu;

        // Edit menu
        NSMenuItem *editItem = [[NSMenuItem alloc] init];
        [menubar addItem:editItem];
        NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
        [editMenu addItem:Item(@"Undo", @selector(undo:), @"z", 0)];
        [editMenu addItem:Item(@"Redo", @selector(redo:), @"z",
                               NSEventModifierFlagCommand | NSEventModifierFlagShift)];
        [editMenu addItem:[NSMenuItem separatorItem]];
        [editMenu addItem:Item(@"Cut", @selector(cut:), @"x", 0)];
        [editMenu addItem:Item(@"Copy", @selector(copy:), @"c", 0)];
        [editMenu addItem:Item(@"Paste", @selector(paste:), @"v", 0)];
        [editMenu addItem:Item(@"Select All", @selector(selectAll:), @"a", 0)];
        [editMenu addItem:[NSMenuItem separatorItem]];
        // Plain Copy gives the rendered text, which loses every heading, bullet
        // and emphasis. These two give the markdown itself.
        [editMenu addItem:Item(@"Copy as Markdown", @selector(copyAsMarkdown:), @"c",
                               NSEventModifierFlagCommand | NSEventModifierFlagShift)];
        [editMenu addItem:Item(@"Copy Whole Note as Markdown", @selector(copyWholeNote:), @"", 0)];
        [editMenu addItem:[NSMenuItem separatorItem]];

        NSMenuItem *findRoot = [[NSMenuItem alloc] initWithTitle:@"Find" action:nil keyEquivalent:@""];
        NSMenu *findMenu = [[NSMenu alloc] initWithTitle:@"Find"];
        NSMenuItem *find = Item(@"Find…", @selector(performFindPanelAction:), @"f", 0);
        find.tag = NSTextFinderActionShowFindInterface;
        NSMenuItem *findNext = Item(@"Find Next", @selector(performFindPanelAction:), @"g", 0);
        findNext.tag = NSTextFinderActionNextMatch;
        NSMenuItem *findPrev = Item(@"Find Previous", @selector(performFindPanelAction:), @"g",
                                    NSEventModifierFlagCommand | NSEventModifierFlagShift);
        findPrev.tag = NSTextFinderActionPreviousMatch;
        [findMenu addItem:find];
        [findMenu addItem:findNext];
        [findMenu addItem:findPrev];
        findRoot.submenu = findMenu;
        [editMenu addItem:findRoot];
        editItem.submenu = editMenu;

        // Format menu — targets the front document; disabled in reading view.
        NSMenuItem *formatItem = [[NSMenuItem alloc] init];
        [menubar addItem:formatItem];
        NSMenu *formatMenu = [[NSMenu alloc] initWithTitle:@"Format"];
        [formatMenu addItem:Item(@"Bold", @selector(fmtBold:), @"b", 0)];
        [formatMenu addItem:Item(@"Italic", @selector(fmtItalic:), @"i", 0)];
        [formatMenu addItem:Item(@"Underline", @selector(fmtUnderline:), @"u", 0)];
        [formatMenu addItem:Item(@"Strikethrough", @selector(fmtStrike:), @"x",
                                 NSEventModifierFlagCommand | NSEventModifierFlagShift)];
        [formatMenu addItem:Item(@"Highlight", @selector(fmtHighlight:), @"h",
                                 NSEventModifierFlagCommand | NSEventModifierFlagShift)];
        [formatMenu addItem:Item(@"Inline Code", @selector(fmtCode:), @"", 0)];
        [formatMenu addItem:Item(@"Link", @selector(fmtLink:), @"k", 0)];
        [formatMenu addItem:[NSMenuItem separatorItem]];
        [formatMenu addItem:Item(@"Heading 1", @selector(fmtH1:), @"1", 0)];
        [formatMenu addItem:Item(@"Heading 2", @selector(fmtH2:), @"2", 0)];
        [formatMenu addItem:Item(@"Heading 3", @selector(fmtH3:), @"3", 0)];
        [formatMenu addItem:[NSMenuItem separatorItem]];
        [formatMenu addItem:Item(@"Bullet List", @selector(fmtBullets:), @"8",
                                 NSEventModifierFlagCommand | NSEventModifierFlagShift)];
        [formatMenu addItem:Item(@"Checklist", @selector(fmtChecklist:), @"l",
                                 NSEventModifierFlagCommand | NSEventModifierFlagShift)];
        [formatMenu addItem:Item(@"Quote", @selector(fmtQuote:), @"", 0)];
        [formatMenu addItem:Item(@"Callout", @selector(fmtCallout:), @"", 0)];
        [formatMenu addItem:Item(@"Table", @selector(fmtTable:), @"", 0)];
        [formatMenu addItem:Item(@"Code Block", @selector(fmtCodeBlock:), @"", 0)];
        [formatMenu addItem:[NSMenuItem separatorItem]];
        [formatMenu addItem:Item(@"Add Picture…", @selector(fmtImage:), @"i",
                                 NSEventModifierFlagCommand | NSEventModifierFlagShift)];
        [formatMenu addItem:Item(@"Clear Formatting", @selector(fmtClearFormatting:), @"", 0)];
        formatItem.submenu = formatMenu;

        // View menu
        NSMenuItem *viewItem = [[NSMenuItem alloc] init];
        [menubar addItem:viewItem];
        NSMenu *viewMenu = [[NSMenu alloc] initWithTitle:@"View"];
        [viewMenu addItem:Item(@"Edit", @selector(toggleEditMode:), @"e", 0)];
        [viewMenu addItem:[NSMenuItem separatorItem]];

        NSMenuItem *appearanceItem = [[NSMenuItem alloc] initWithTitle:@"Appearance"
                                                                action:nil
                                                         keyEquivalent:@""];
        NSMenu *appearanceMenu = [[NSMenu alloc] initWithTitle:@"Appearance"];
        NSMenuItem *appSystem = Item(@"System", @selector(appearanceSystem:), @"", 0);
        NSMenuItem *appLight = Item(@"Light", @selector(appearanceLight:), @"", 0);
        NSMenuItem *appDark = Item(@"Dark", @selector(appearanceDark:), @"", 0);
        appSystem.target = delegate;
        appLight.target = delegate;
        appDark.target = delegate;
        [appearanceMenu addItem:appSystem];
        [appearanceMenu addItem:appLight];
        [appearanceMenu addItem:appDark];
        appearanceItem.submenu = appearanceMenu;
        [viewMenu addItem:appearanceItem];

        [viewMenu addItem:[NSMenuItem separatorItem]];
        [viewMenu addItem:Item(@"Show Tab Bar", @selector(toggleTabBar:), @"", 0)];
        [viewMenu addItem:Item(@"Show All Tabs", @selector(toggleTabOverview:), @"", 0)];
        viewItem.submenu = viewMenu;

        // Window menu
        NSMenuItem *windowItem = [[NSMenuItem alloc] init];
        [menubar addItem:windowItem];
        NSMenu *windowMenu = [[NSMenu alloc] initWithTitle:@"Window"];
        [windowMenu addItem:Item(@"Minimize", @selector(performMiniaturize:), @"m", 0)];
        [windowMenu addItem:Item(@"Zoom", @selector(performZoom:), @"", 0)];
        [windowMenu addItem:[NSMenuItem separatorItem]];
        [windowMenu addItem:Item(@"Merge All Windows", @selector(mergeAllWindows:), @"", 0)];
        [windowMenu addItem:Item(@"Bring All to Front", @selector(arrangeInFront:), @"", 0)];
        windowItem.submenu = windowMenu;
        app.windowsMenu = windowMenu;

        app.mainMenu = menubar;

        return NSApplicationMain(argc, argv);
    }
}
