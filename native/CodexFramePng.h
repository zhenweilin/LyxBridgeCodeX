// SPDX-License-Identifier: GPL-2.0-or-later
#ifndef LYX_CODEX_FRAME_PNG_H
#define LYX_CODEX_FRAME_PNG_H

#include <QBuffer>
#include <QByteArray>
#include <QColorSpace>
#include <QImage>
#include <QImageWriter>
#include <cstring>
#include <limits>
#include <zlib.h>

namespace lyx { namespace frontend { namespace codex_frame_png {

inline void append32(QByteArray & out, quint32 value)
{
    for (int shift = 24; shift >= 0; shift -= 8)
        out.append(char(value >> shift));
}

inline void appendChunk(QByteArray & out, char const * type, QByteArray const & data)
{
    append32(out, quint32(data.size()));
    out.append(type, 4);
    out.append(data);
    uLong checksum = crc32(0, reinterpret_cast<Bytef const *>(type), 4);
    checksum = crc32(checksum, reinterpret_cast<Bytef const *>(data.constData()),
        uInt(data.size()));
    append32(out, quint32(checksum));
}

inline bool canEncode(QImage const & image)
{
    // Widget grabs have ordinary 8-bit pixels. Leave unusual formats and
    // ancillary metadata to Qt rather than reducing their precision or
    // silently dropping a profile, text entry, or image offset.
    if (image.isNull() || image.colorSpace().isValid()
        || !image.textKeys().isEmpty() || !image.offset().isNull()) return false;
    switch (image.format()) {
    case QImage::Format_RGB32:
    case QImage::Format_ARGB32:
    case QImage::Format_ARGB32_Premultiplied:
    case QImage::Format_RGB888:
    case QImage::Format_RGBX8888:
    case QImage::Format_RGBA8888:
    case QImage::Format_RGBA8888_Premultiplied:
        return true;
    default:
        return false;
    }
}

inline bool encode(QImage const & image, QByteArray & png)
{
    png.clear();
    if (canEncode(image)) {
        bool const alpha = image.hasAlphaChannel();
        quint64 const rowBytes = quint64(image.width()) * (alpha ? 4 : 3);
        quint64 const rawBytes = (rowBytes + 1) * quint64(image.height());
        if (rawBytes <= quint64(std::numeric_limits<int>::max())) {
            // Use byte-ordered, straight-alpha formats: copying the native
            // ARGB word representation would depend on CPU endianness, and
            // PNG must never contain premultiplied color channels.
            QImage const pixels = image.convertToFormat(alpha
                ? QImage::Format_RGBA8888 : QImage::Format_RGB888);
            if (!pixels.isNull()) {
                QByteArray raw(int(rawBytes), Qt::Uninitialized);
                for (int y = 0; y < pixels.height(); ++y) {
                    char * row = raw.data() + quint64(y) * (rowBytes + 1);
                    // Fixed PNG filter None avoids libpng's per-row filter
                    // search. Compression is still lossless; no resizing or
                    // palette reduction occurs, including on Retina displays.
                    row[0] = 0;
                    std::memcpy(row + 1, pixels.constScanLine(y), size_t(rowBytes));
                }
                QByteArray compressed = qCompress(raw, 1);
                if (compressed.size() > 4) {
                    // qCompress adds a four-byte length before the standard
                    // zlib stream. PNG IDAT contains only the zlib stream.
                    compressed.remove(0, 4);
                    png.append("\211PNG\r\n\032\n", 8);
                    QByteArray header;
                    append32(header, quint32(image.width()));
                    append32(header, quint32(image.height()));
                    header.append(char(8));
                    header.append(char(alpha ? 6 : 2));
                    header.append(QByteArray(3, 0));
                    appendChunk(png, "IHDR", header);
                    QByteArray density;
                    append32(density, quint32(image.dotsPerMeterX()));
                    append32(density, quint32(image.dotsPerMeterY()));
                    density.append(char(1));
                    appendChunk(png, "pHYs", density);
                    appendChunk(png, "IDAT", compressed);
                    appendChunk(png, "IEND", QByteArray());
                    return true;
                }
            }
        }
    }

    QBuffer out(&png);
    if (!out.open(QIODevice::WriteOnly)) return false;
    QImageWriter writer(&out, "PNG");
    // Qt 5 maps [0,100] to zlib [0,9]; 11 selects compression level 1.
    writer.setCompression(11);
    return writer.write(image);
}

}}} // namespace lyx::frontend::codex_frame_png

#endif
