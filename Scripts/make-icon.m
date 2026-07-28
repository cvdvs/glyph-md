// Draws the Glyph app icon (purple gradient squircle, white "#") as a 1024px PNG.
// Build and run:
//   clang -fobjc-arc Scripts/make-icon.m -o /tmp/glyph-make-icon -framework Cocoa
//   /tmp/glyph-make-icon assets/icon-1024.png
#import <Cocoa/Cocoa.h>

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSString *out = argc > 1 ? @(argv[1]) : @"icon-1024.png";
        CGFloat size = 1024;

        NSBitmapImageRep *rep = [[NSBitmapImageRep alloc]
            initWithBitmapDataPlanes:NULL
                          pixelsWide:(NSInteger)size
                          pixelsHigh:(NSInteger)size
                       bitsPerSample:8
                     samplesPerPixel:4
                            hasAlpha:YES
                            isPlanar:NO
                      colorSpaceName:NSDeviceRGBColorSpace
                         bytesPerRow:0
                        bitsPerPixel:0];

        [NSGraphicsContext saveGraphicsState];
        [NSGraphicsContext setCurrentContext:
            [NSGraphicsContext graphicsContextWithBitmapImageRep:rep]];

        // Full-bleed rounded square with the standard macOS icon margin.
        CGFloat inset = 100;
        NSRect rect = NSMakeRect(inset, inset, size - 2 * inset, size - 2 * inset);
        NSBezierPath *path = [NSBezierPath bezierPathWithRoundedRect:rect xRadius:185 yRadius:185];

        NSColor *electricPurple = [NSColor colorWithCalibratedRed:0.718 green:0.0 blue:1.0 alpha:1.0];   // #B700FF
        NSColor *electricIndigo = [NSColor colorWithCalibratedRed:0.412 green:0.267 blue:1.0 alpha:1.0]; // #6944FF
        NSGradient *gradient = [[NSGradient alloc] initWithStartingColor:electricPurple
                                                             endingColor:electricIndigo];
        [gradient drawInBezierPath:path angle:-70];

        NSMutableParagraphStyle *para = [[NSMutableParagraphStyle alloc] init];
        para.alignment = NSTextAlignmentCenter;
        NSAttributedString *mark = [[NSAttributedString alloc]
            initWithString:@"#"
                attributes:@{
                    NSFontAttributeName: [NSFont systemFontOfSize:540 weight:NSFontWeightBold],
                    NSForegroundColorAttributeName: [NSColor whiteColor],
                    NSParagraphStyleAttributeName: para,
                }];
        NSSize ts = mark.size;
        [mark drawAtPoint:NSMakePoint((size - ts.width) / 2, (size - ts.height) / 2)];

        [NSGraphicsContext restoreGraphicsState];

        NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (![png writeToFile:out atomically:YES]) {
            fprintf(stderr, "failed to write %s\n", out.UTF8String);
            return 1;
        }
        printf("wrote %s\n", out.UTF8String);
    }
    return 0;
}
