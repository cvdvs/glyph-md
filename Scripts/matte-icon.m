// Turns flat icon artwork on a black background into a macOS app icon PNG:
// 1) flood-fills near-black from the edges to transparent,
// 2) un-blends the black matte on the boundary so there's no dark fringe,
// 3) crops to the artwork and centers it in a 1024 canvas with the standard margin.
// Build and run:
//   clang -fobjc-arc Scripts/matte-icon.m -o /tmp/glyph-matte-icon -framework Cocoa
//   /tmp/glyph-matte-icon input.png assets/icon-1024.png
#import <Cocoa/Cocoa.h>

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc < 3) { fprintf(stderr, "usage: matte-icon in.png out.png\n"); return 1; }
        NSData *data = [NSData dataWithContentsOfFile:@(argv[1])];
        NSBitmapImageRep *srcRep = [NSBitmapImageRep imageRepWithData:data];
        if (!srcRep) { fprintf(stderr, "cannot read %s\n", argv[1]); return 1; }
        NSInteger W = srcRep.pixelsWide, H = srcRep.pixelsHigh;

        NSBitmapImageRep *rep = [[NSBitmapImageRep alloc]
            initWithBitmapDataPlanes:NULL pixelsWide:W pixelsHigh:H
                       bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO
                      colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:W * 4 bitsPerPixel:32];
        memset(rep.bitmapData, 0, rep.bytesPerRow * H);
        [NSGraphicsContext saveGraphicsState];
        NSGraphicsContext.currentContext = [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
        [srcRep drawInRect:NSMakeRect(0, 0, W, H)];
        [NSGraphicsContext restoreGraphicsState];

        unsigned char *px = rep.bitmapData;
        NSInteger stride = rep.bytesPerRow;
        #define P(x, y) (px + (y) * stride + (x) * 4)
        #define IDX(x, y) ((y) * W + (x))

        unsigned char *mark = calloc(W * H, 1);
        NSInteger *queue = malloc(sizeof(NSInteger) * W * H);
        NSInteger qh = 0, qt = 0;
        const int T = 26;
        #define TRYPUSH(x, y) do { \
            if ((x) >= 0 && (x) < W && (y) >= 0 && (y) < H && !mark[IDX(x, y)]) { \
                unsigned char *p = P(x, y); \
                if (p[0] < T && p[1] < T && p[2] < T) { mark[IDX(x, y)] = 1; queue[qt++] = IDX(x, y); } \
            } \
        } while (0)

        for (NSInteger x = 0; x < W; x++) { TRYPUSH(x, 0); TRYPUSH(x, H - 1); }
        for (NSInteger y = 0; y < H; y++) { TRYPUSH(0, y); TRYPUSH(W - 1, y); }
        while (qh < qt) {
            NSInteger i = queue[qh++];
            NSInteger x = i % W, y = i / W;
            TRYPUSH(x + 1, y); TRYPUSH(x - 1, y); TRYPUSH(x, y + 1); TRYPUSH(x, y - 1);
        }
        for (NSInteger y = 0; y < H; y++) {
            for (NSInteger x = 0; x < W; x++) {
                if (mark[IDX(x, y)]) { unsigned char *p = P(x, y); p[0] = p[1] = p[2] = p[3] = 0; }
            }
        }

        // Un-blend the black matte on a few boundary rings.
        for (int pass = 0; pass < 3; pass++) {
            unsigned char *ring = calloc(W * H, 1);
            for (NSInteger y = 0; y < H; y++) {
                for (NSInteger x = 0; x < W; x++) {
                    if (mark[IDX(x, y)]) continue;
                    BOOL adjacent =
                        (x > 0 && mark[IDX(x - 1, y)]) || (x < W - 1 && mark[IDX(x + 1, y)]) ||
                        (y > 0 && mark[IDX(x, y - 1)]) || (y < H - 1 && mark[IDX(x, y + 1)]);
                    if (!adjacent) continue;
                    unsigned char *p = P(x, y);
                    int mx = MAX(p[0], MAX(p[1], p[2]));
                    if (mx == 0) {
                        p[3] = 0;
                    } else {
                        float a = mx / 255.0f;
                        p[0] = (unsigned char)MIN(255.0f, p[0] / a);
                        p[1] = (unsigned char)MIN(255.0f, p[1] / a);
                        p[2] = (unsigned char)MIN(255.0f, p[2] / a);
                        p[3] = (unsigned char)(p[3] * a);
                    }
                    ring[IDX(x, y)] = 1;
                }
            }
            for (NSInteger i = 0; i < W * H; i++) mark[i] |= ring[i];
            free(ring);
        }

        // Crop to visible content.
        NSInteger minX = W, minY = H, maxX = -1, maxY = -1;
        for (NSInteger y = 0; y < H; y++) {
            for (NSInteger x = 0; x < W; x++) {
                if (P(x, y)[3] > 8) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < 0) { fprintf(stderr, "image is entirely background\n"); return 1; }
        NSInteger bw = maxX - minX + 1, bh = maxY - minY + 1;

        // Center in the standard 1024 icon canvas (content ≈ 828px).
        CGFloat canvas = 1024, targetSize = 828;
        CGFloat scale = targetSize / MAX(bw, bh);
        CGFloat dw = bw * scale, dh = bh * scale;
        NSBitmapImageRep *out = [[NSBitmapImageRep alloc]
            initWithBitmapDataPlanes:NULL pixelsWide:(NSInteger)canvas pixelsHigh:(NSInteger)canvas
                       bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO
                      colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
        NSImage *img = [[NSImage alloc] initWithSize:NSMakeSize(W, H)];
        [img addRepresentation:rep];
        [NSGraphicsContext saveGraphicsState];
        NSGraphicsContext.currentContext = [NSGraphicsContext graphicsContextWithBitmapImageRep:out];
        NSGraphicsContext.currentContext.imageInterpolation = NSImageInterpolationHigh;
        // fromRect is in bottom-up image coordinates.
        NSRect fromRect = NSMakeRect(minX, H - 1 - maxY, bw, bh);
        [img drawInRect:NSMakeRect((canvas - dw) / 2, (canvas - dh) / 2, dw, dh)
               fromRect:fromRect
              operation:NSCompositingOperationSourceOver
               fraction:1.0];
        [NSGraphicsContext restoreGraphicsState];

        NSData *png = [out representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (![png writeToFile:@(argv[2]) atomically:YES]) {
            fprintf(stderr, "failed to write %s\n", argv[2]);
            return 1;
        }
        printf("wrote %s (%ldx%ld content)\n", argv[2], (long)bw, (long)bh);
        free(mark);
        free(queue);
    }
    return 0;
}
