// SPDX-License-Identifier: GPL-2.0-or-later
// Standalone encoder checks: no running LyX session or document is touched.
#include "CodexFramePng.h"
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QFile>
#include <QTextStream>
#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <vector>

namespace png = lyx::frontend::codex_frame_png;

static void require(bool ok, char const * message)
{
    if (!ok) { std::cerr << message << '\n'; std::exit(1); }
}

static quint32 read32(QByteArray const & bytes, int offset)
{
    require(offset >= 0 && offset <= bytes.size() - 4, "Truncated PNG integer");
    auto const * p = reinterpret_cast<unsigned char const *>(bytes.constData() + offset);
    return (quint32(p[0]) << 24) | (quint32(p[1]) << 16) | (quint32(p[2]) << 8) | p[3];
}

static QByteArray qtPng(QImage const & image)
{
    QByteArray result;
    QBuffer buffer(&result);
    require(buffer.open(QIODevice::WriteOnly), "Could not open PNG buffer");
    QImageWriter writer(&buffer, "PNG");
    writer.setCompression(11);
    require(writer.write(image), "Qt PNG encode failed");
    return result;
}

static void checkChunks(QByteArray const & encoded, QImage const & image, bool fast)
{
    require(encoded.left(8) == QByteArray("\211PNG\r\n\032\n", 8), "Invalid PNG signature");
    int offset = 8, count = 0;
    bool ended = false, densityFound = false;
    QByteArray compressed;
    int channels = 0;
    while (offset < encoded.size()) {
        require(encoded.size() - offset >= 12, "Truncated PNG chunk");
        quint32 const length = read32(encoded, offset);
        require(length <= quint32(encoded.size() - offset - 12), "PNG chunk length exceeds buffer");
        QByteArray const type = encoded.mid(offset + 4, 4);
        QByteArray const data = encoded.mid(offset + 8, int(length));
        uLong const crc = crc32(0, reinterpret_cast<Bytef const *>(encoded.constData() + offset + 4), length + 4);
        require(quint32(crc) == read32(encoded, offset + 8 + int(length)), "Invalid PNG chunk CRC");
        require(!ended, "PNG chunk after IEND");
        if (count++ == 0) require(type == "IHDR", "IHDR must be first");
        if (type == "IHDR") {
            require(data.size() == 13, "Invalid IHDR size");
            require(read32(data, 0) == quint32(image.width()) && read32(data, 4) == quint32(image.height()),
                "Native pixel dimensions changed");
            if (fast) {
                require(data[8] == 8 && (data[9] == 2 || data[9] == 6), "Unexpected fast PNG format");
                channels = data[9] == 6 ? 4 : 3;
            }
        } else if (type == "pHYs") {
            require(data.size() == 9 && data[8] == 1, "Invalid physical density");
            require(read32(data, 0) == quint32(image.dotsPerMeterX())
                && read32(data, 4) == quint32(image.dotsPerMeterY()), "Physical density changed");
            densityFound = true;
        } else if (type == "IDAT") {
            compressed += data;
        } else if (type == "IEND") {
            require(data.isEmpty(), "Invalid IEND");
            ended = true;
        }
        offset += int(length) + 12;
    }
    require(ended, "Missing IEND");
    if (fast) {
        require(densityFound, "Missing physical density");
        quint32 const stride = quint32(image.width() * channels + 1);
        QByteArray data;
        png::append32(data, stride * quint32(image.height()));
        data += compressed;
        QByteArray const raw = qUncompress(data);
        require(raw.size() == int(stride * quint32(image.height())), "Invalid zlib stream");
        for (int y = 0; y < image.height(); ++y)
            require(raw[int(stride) * y] == 0, "Expected fixed filter None");
    }
}

static int cases = 0;
static void check(QImage const & image, bool fast)
{
    require(png::canEncode(image) == fast, "Unexpected encoder path");
    QByteArray actual;
    require(png::encode(image, actual), "Native PNG encode failed");
    QByteArray const expected = qtPng(image);
    checkChunks(actual, image, fast);
    QImage const decoded = QImage::fromData(actual, "PNG");
    QImage const baseline = QImage::fromData(expected, "PNG");
    require(!decoded.isNull() && !baseline.isNull(), "PNG decode failed");
    require(decoded.convertToFormat(QImage::Format_RGBA64) == baseline.convertToFormat(QImage::Format_RGBA64),
        "Decoded pixels differ from Qt PNG");
    require(decoded.dotsPerMeterX() == baseline.dotsPerMeterX()
        && decoded.dotsPerMeterY() == baseline.dotsPerMeterY(), "Decoded density differs from Qt PNG");
    require(decoded.colorSpace() == baseline.colorSpace(), "Color space differs from Qt PNG");
    require(decoded.textKeys() == baseline.textKeys() && decoded.offset() == baseline.offset(),
        "Ancillary metadata differs from Qt PNG");
    if (!fast) require(actual == expected, "Fallback differs from original Qt writer");
    ++cases;
}

static void benchmark(QImage const & image, char const * label)
{
    std::vector<double> fast, original;
    QByteArray actual, expected;
    for (int i = 0; i < 64; ++i) {
        QElapsedTimer timer;
        timer.start();
        require(png::encode(image, actual), "Benchmark PNG encode failed");
        double const fastTime = timer.nsecsElapsed() / 1e6;
        timer.restart();
        expected = qtPng(image);
        double const originalTime = timer.nsecsElapsed() / 1e6;
        if (i >= 4) { fast.push_back(fastTime); original.push_back(originalTime); }
    }
    std::sort(fast.begin(), fast.end());
    std::sort(original.begin(), original.end());
    std::cout << label << ": native median=" << fast[30] << "ms p95=" << fast[57]
        << "ms bytes=" << actual.size() << "; Qt median=" << original[30]
        << "ms p95=" << original[57] << "ms bytes=" << expected.size() << '\n';
}

int main(int argc, char ** argv)
{
    QCoreApplication application(argc, argv);
    for (int width : {1, 2, 3, 5, 17}) {
        QImage source(width, 9, QImage::Format_ARGB32);
        for (int y = 0; y < source.height(); ++y)
            for (int x = 0; x < source.width(); ++x) {
                int const alphas[] = {0, 1, 127, 128, 254, 255};
                source.setPixel(x, y, qRgba((x * 67 + y * 11) % 256, (x * 31 + y * 37) % 256,
                    (x * 43 + y * 53) % 256, alphas[(x + y) % 6]));
            }
        for (auto format : {QImage::Format_RGB32, QImage::Format_ARGB32,
            QImage::Format_ARGB32_Premultiplied, QImage::Format_RGB888,
            QImage::Format_RGBX8888, QImage::Format_RGBA8888, QImage::Format_RGBA8888_Premultiplied}) {
            QImage image = source.convertToFormat(format);
            image.setDevicePixelRatio(2);
            image.setDotsPerMeterX(7559);
            image.setDotsPerMeterY(7560);
            check(image, true);
        }
        for (auto format : {QImage::Format_RGB16, QImage::Format_Indexed8, QImage::Format_Grayscale8,
            QImage::Format_Grayscale16, QImage::Format_Mono, QImage::Format_RGBA64,
            QImage::Format_RGBA64_Premultiplied}) check(source.convertToFormat(format), false);
        QImage profile = source;
        profile.setColorSpace(QColorSpace(QColorSpace::SRgb));
        check(profile, false);
        QImage text = source;
        text.setText("Description", "Native frame metadata");
        check(text, false);
        QImage offset = source;
        offset.setOffset(QPoint(3, -7));
        check(offset, false);
    }
    QByteArray invalid("previous frame");
    require(!png::encode(QImage(), invalid) && invalid.isEmpty(), "Invalid image retained stale PNG");
    for (int i = 1; i < argc; ++i) {
        QImage fixture(QString::fromLocal8Bit(argv[i]));
        require(!fixture.isNull(), "Could not load native frame fixture");
        check(fixture, png::canEncode(fixture));
        benchmark(fixture, argv[i]);
    }
    std::cout << "Passed " << cases << " pixel, alpha, format, metadata and CRC cases; null image rejected.\n";
    return 0;
}
