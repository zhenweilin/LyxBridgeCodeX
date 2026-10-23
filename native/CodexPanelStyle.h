// SPDX-License-Identifier: GPL-2.0-or-later
#ifndef LYX_CODEX_PANEL_STYLE_H
#define LYX_CODEX_PANEL_STYLE_H

#include <QPainter>
#include <QProxyStyle>
#include <QStyleOption>
#include <QWidget>

namespace lyx { namespace frontend {

// Cocoa's complete widget style requires a native macOS window. Keep Fusion's
// controls in the offscreen editor, with quiet chrome and arrowless scrollbars.
class CodexPanelStyle : public QProxyStyle {
public:
    explicit CodexPanelStyle(QString const & base) : QProxyStyle(base) {}

    int styleHint(StyleHint hint, QStyleOption const * option = nullptr,
        QWidget const * widget = nullptr, QStyleHintReturn * data = nullptr) const override {
        // Long menus scroll inside the panel instead of adding hidden columns.
        if (hint == SH_Menu_Scrollable) return 1;
        if (hint == SH_UnderlineShortcut) return 0;
        return QProxyStyle::styleHint(hint, option, widget, data);
    }

    int pixelMetric(PixelMetric metric, QStyleOption const * option = nullptr,
        QWidget const * widget = nullptr) const override {
        // A fixed hit area stays easy to drag and never changes layout on hover.
        if (metric == PM_ScrollBarExtent) return 14;
        if (metric == PM_ScrollBarSliderMin) return 26;
        return QProxyStyle::pixelMetric(metric, option, widget);
    }

    QRect subControlRect(ComplexControl control, QStyleOptionComplex const * option,
        SubControl part, QWidget const * widget = nullptr) const override {
        auto const * bar = qstyleoption_cast<QStyleOptionSlider const *>(option);
        if (control != CC_ScrollBar || !bar)
            return QProxyStyle::subControlRect(control, option, part, widget);
        bool const vertical = bar->orientation == Qt::Vertical;
        QRect const groove = bar->rect;
        int const length = vertical ? groove.height() : groove.width();
        qint64 const range = qMax<qint64>(0, qint64(bar->maximum) - bar->minimum);
        qint64 const page = qMax(0, bar->pageStep);
        int const thumb = range == 0 ? length : qBound(qMin(26, length),
            int(page * length / qMax<qint64>(1, range + page)), length);
        int const offset = sliderPositionFromValue(bar->minimum, bar->maximum,
            bar->sliderPosition, qMax(0, length - thumb), bar->upsideDown);
        auto slice = [&](int start, int size) {
            QRect const logical = vertical ? QRect(groove.x(), groove.y() + start, groove.width(), size)
                : QRect(groove.x() + start, groove.y(), size, groove.height());
            // Qt's horizontal drag direction also follows the widget's layout
            // direction, independently of the inverted-appearance setting.
            return visualRect(bar->direction, bar->rect, logical);
        };
        if (part == SC_ScrollBarGroove) return groove;
        if (part == SC_ScrollBarSlider) return slice(offset, thumb);
        if (part == SC_ScrollBarSubPage)
            return bar->upsideDown ? slice(offset + thumb, length - offset - thumb) : slice(0, offset);
        if (part == SC_ScrollBarAddPage)
            return bar->upsideDown ? slice(0, offset) : slice(offset + thumb, length - offset - thumb);
        // Removed arrow buttons must also have no active hit regions.
        return QRect();
    }

    SubControl hitTestComplexControl(ComplexControl control, QStyleOptionComplex const * option,
        QPoint const & point, QWidget const * widget = nullptr) const override {
        if (control != CC_ScrollBar)
            return QProxyStyle::hitTestComplexControl(control, option, point, widget);
        for (auto part : {SC_ScrollBarSlider, SC_ScrollBarSubPage, SC_ScrollBarAddPage})
            if (subControlRect(control, option, part, widget).contains(point)) return part;
        return SC_None;
    }

    void drawComplexControl(ComplexControl control, QStyleOptionComplex const * option,
        QPainter * painter, QWidget const * widget = nullptr) const override {
        auto const * bar = qstyleoption_cast<QStyleOptionSlider const *>(option);
        if (control != CC_ScrollBar || !bar) {
            QProxyStyle::drawComplexControl(control, option, painter, widget);
            return;
        }
        painter->save();
        painter->fillRect(bar->rect, QColor(247, 247, 249));
        if (bar->maximum > bar->minimum && (bar->state & State_Enabled)) {
            bool const active = bar->activeSubControls & SC_ScrollBarSlider;
            bool const hovered = bar->state & State_MouseOver;
            bool const pressed = active && (bar->state & State_Sunken);
            QRectF thumb = subControlRect(control, option, SC_ScrollBarSlider, widget);
            qreal const inset = hovered || pressed ? 3 : 4;
            if (bar->orientation == Qt::Vertical) thumb.adjust(inset, 2, -inset, -2);
            else thumb.adjust(2, inset, -2, -inset);
            painter->setRenderHint(QPainter::Antialiasing);
            painter->setPen(Qt::NoPen);
            painter->setBrush(QColor(110, 110, 115, pressed ? 230 : hovered ? 190 : 145));
            painter->drawRoundedRect(thumb, 4, 4);
        }
        painter->restore();
    }

    void drawControl(ControlElement element, QStyleOption const * option,
        QPainter * painter, QWidget const * widget = nullptr) const override {
        if (element == CE_ToolBar || element == CE_MenuBarEmptyArea) {
            painter->fillRect(option->rect, QColor(246, 246, 248));
            return;
        }
        if (element == CE_MenuBarItem) {
            if (auto const * item = qstyleoption_cast<QStyleOptionMenuItem const *>(option)) {
                QStyleOptionMenuItem copy(*item);
                copy.palette.setColor(QPalette::Button, QColor(246, 246, 248));
                copy.palette.setColor(QPalette::Window, QColor(246, 246, 248));
                QProxyStyle::drawControl(element, &copy, painter, widget);
                return;
            }
        }
        QProxyStyle::drawControl(element, option, painter, widget);
    }

    void drawPrimitive(PrimitiveElement element, QStyleOption const * option,
        QPainter * painter, QWidget const * widget = nullptr) const override {
        if (element == PE_PanelMenuBar || element == PE_PanelStatusBar) {
            painter->fillRect(option->rect, QColor(246, 246, 248));
            return;
        }
        if (element == PE_PanelButtonTool) {
            if (option->state & (State_MouseOver | State_Sunken | State_On)) {
                painter->save();
                painter->setRenderHint(QPainter::Antialiasing);
                painter->setPen(Qt::NoPen);
                painter->setBrush(option->state & (State_Sunken | State_On)
                    ? QColor(215, 225, 239) : QColor(229, 229, 234));
                painter->drawRoundedRect(QRectF(option->rect).adjusted(1, 1, -1, -1), 5, 5);
                painter->restore();
            }
            return;
        }
        QProxyStyle::drawPrimitive(element, option, painter, widget);
    }
};

} }
#endif
