// SPDX-License-Identifier: GPL-2.0-or-later
// Exercise real Qt scrollbar events against the embedded editor's style.
#include "CodexPanelStyle.h"
#include <QApplication>
#include <QMouseEvent>
#include <QScrollBar>
#include <QStyleFactory>
#include <QStyleOptionSlider>
#include <QTest>
#include <QWheelEvent>
#include <cstdlib>
#include <iostream>

class ScrollBar : public QScrollBar {
public:
    explicit ScrollBar(Qt::Orientation orientation) : QScrollBar(orientation) {}
    QStyleOptionSlider option() const {
        QStyleOptionSlider result;
        initStyleOption(&result);
        return result;
    }
    QRect part(QStyle::SubControl control) const {
        auto const current = option();
        return style()->subControlRect(QStyle::CC_ScrollBar, &current, control, this);
    }
};

static void require(bool condition, char const * message)
{
    if (condition) return;
    std::cerr << "FAIL: " << message << std::endl;
    std::exit(1);
}

static QPoint endPoint(ScrollBar const & bar, bool end)
{
    QRect const bounds = bar.rect();
    return bar.orientation() == Qt::Vertical
        ? QPoint(bounds.center().x(), end ? bounds.bottom() - 1 : bounds.top() + 1)
        : QPoint(end ? bounds.right() - 1 : bounds.left() + 1, bounds.center().y());
}

static void moveWhilePressed(ScrollBar & bar, QPoint const & point)
{
    QMouseEvent move(QEvent::MouseMove, point, bar.mapToGlobal(point),
        Qt::NoButton, Qt::LeftButton, Qt::NoModifier);
    QApplication::sendEvent(&bar, &move);
    QApplication::processEvents();
}

static void wheel(ScrollBar & bar, int delta)
{
    QPoint const point = bar.rect().center();
    QWheelEvent event(point, bar.mapToGlobal(point), QPoint(), QPoint(0, delta),
        Qt::NoButton, Qt::NoModifier, Qt::NoScrollPhase, false);
    QApplication::sendEvent(&bar, &event);
    QApplication::processEvents();
}

static void configure(ScrollBar & bar, Qt::LayoutDirection direction, bool inverted)
{
    bar.setLayoutDirection(direction);
    bar.setInvertedAppearance(inverted);
    bar.setRange(10, 110);
    bar.setSingleStep(3);
    bar.setPageStep(20);
    bar.setValue(60);
    if (bar.orientation() == Qt::Vertical) bar.resize(bar.sizeHint().width(), 240);
    else bar.resize(240, bar.sizeHint().height());
    bar.show();
    QApplication::processEvents();
}

static void check(Qt::Orientation orientation, Qt::LayoutDirection direction, bool inverted)
{
    ScrollBar bar(orientation);
    configure(bar, direction, inverted);
    std::cout << (orientation == Qt::Vertical ? "vertical" : "horizontal")
        << ' ' << (direction == Qt::LeftToRight ? "LTR" : "RTL")
        << (inverted ? " inverted" : " normal") << std::endl;

    // Use a real Fusion widget to determine the physical range direction,
    // including Qt's separate horizontal RTL and inverted-appearance rules.
    ScrollBar reference(orientation);
    QStyle * fusion = QStyleFactory::create("Fusion");
    require(fusion != nullptr, "Fusion reference style must be available");
    fusion->setParent(&reference);
    reference.setStyle(fusion);
    configure(reference, direction, inverted);
    reference.setValue(reference.minimum());
    QPoint const minimumCenter = reference.part(QStyle::SC_ScrollBarSlider).center();
    reference.setValue(reference.maximum());
    QPoint const maximumCenter = reference.part(QStyle::SC_ScrollBarSlider).center();
    bool const minimumAtStart = orientation == Qt::Vertical
        ? minimumCenter.y() < maximumCenter.y() : minimumCenter.x() < maximumCenter.x();
    for (bool end : {false, true}) {
        bar.setValue(60);
        QTest::mouseClick(&bar, Qt::LeftButton, Qt::NoModifier, endPoint(bar, end));
        int const expected = 60 + (end == minimumAtStart ? bar.pageStep() : -bar.pageStep());
        require(bar.value() == expected, "track ends must page, with no invisible arrow action");
    }

    bar.setValue(60);
    QTest::mousePress(&bar, Qt::LeftButton, Qt::NoModifier,
        bar.part(QStyle::SC_ScrollBarSlider).center());
    require(bar.isSliderDown(), "press on visible thumb must begin native dragging");
    for (bool end : {false, true}) {
        moveWhilePressed(bar, endPoint(bar, end));
        int const expected = end == minimumAtStart ? bar.maximum() : bar.minimum();
        require(bar.value() == expected, "native thumb drag must reach each range endpoint");
        require(bar.part(QStyle::SC_ScrollBarSlider).contains(endPoint(bar, end)),
            "thumb drawing must follow the physical drag direction");
    }
    QTest::mouseRelease(&bar, Qt::LeftButton, Qt::NoModifier, endPoint(bar, true));
    require(!bar.isSliderDown(), "release must end native dragging");

    // Compare non-pointer inputs with an unchanged Fusion widget. This checks
    // Qt's own direction, wheel-line and keyboard behavior without re-creating it.
    for (auto key : {Qt::Key_Left, Qt::Key_Right, Qt::Key_Up, Qt::Key_Down,
             Qt::Key_PageUp, Qt::Key_PageDown, Qt::Key_Home, Qt::Key_End}) {
        bar.setValue(60);
        reference.setValue(60);
        QTest::keyClick(&bar, key);
        QTest::keyClick(&reference, key);
        require(bar.value() == reference.value(), "keyboard handling must remain native");
    }
    for (int delta : {-120, 120}) {
        bar.setValue(60);
        reference.setValue(60);
        wheel(bar, delta);
        wheel(reference, delta);
        require(bar.value() != 60, "wheel must move the scrollbar");
        require(bar.value() == reference.value(), "wheel handling must remain native");
    }

    bar.setValue(60);
    QEvent leave(QEvent::Leave);
    QApplication::sendEvent(&bar, &leave);
    QSize const sizeHint = bar.sizeHint();
    QRect const geometry = bar.geometry();
    QRect const groove = bar.part(QStyle::SC_ScrollBarGroove);
    QRect const thumb = bar.part(QStyle::SC_ScrollBarSlider);
    QEvent enter(QEvent::Enter);
    QApplication::sendEvent(&bar, &enter);
    require(bar.option().state & QStyle::State_MouseOver, "hover check must enter the widget");
    bar.grab(); // Paint the hovered state as the bridge does for native frames.
    require(bar.sizeHint() == sizeHint && bar.geometry() == geometry,
        "hover must preserve widget dimensions");
    require(bar.part(QStyle::SC_ScrollBarGroove) == groove
        && bar.part(QStyle::SC_ScrollBarSlider) == thumb,
        "hover must preserve native groove and thumb hit areas");
}

int main(int argc, char ** argv)
{
    QApplication app(argc, argv);
    app.setStyle(new lyx::frontend::CodexPanelStyle("Fusion"));
    for (auto orientation : {Qt::Vertical, Qt::Horizontal})
        for (auto direction : {Qt::LeftToRight, Qt::RightToLeft})
            for (bool inverted : {false, true}) check(orientation, direction, inverted);
    std::cout << "Native scrollbar checks passed (8 configurations)" << std::endl;
    return 0;
}
