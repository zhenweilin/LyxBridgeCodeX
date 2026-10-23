// SPDX-License-Identifier: GPL-2.0-or-later
#include <config.h>
#include "CodexColorToolbar.h"
#include "CodexSelectionEdit.h"
#include "GuiApplication.h"
#include "GuiView.h"
#include "GuiWorkArea.h"
#include "Buffer.h"
#include "BufferView.h"
#include "Cursor.h"
#include "support/qstring_helpers.h"
#include <QAction>
#include <QApplication>
#include <QColorDialog>
#include <QGridLayout>
#include <QKeyEvent>
#include <QLabel>
#include <QMenu>
#include <QPainter>
#include <QPointer>
#include <QPushButton>
#include <QSettings>
#include <QTimer>
#include <QToolBar>
#include <QToolButton>
#include <QVBoxLayout>
#include <QWidgetAction>

namespace lyx { namespace frontend {
namespace {
class ColorMenu : public QMenu {
public:
    explicit ColorMenu(QWidget * parent) : QMenu(parent) {}
    void keyPressEvent(QKeyEvent * event) override {
        // The offscreen bridge routes keys to the active popup. Forward palette
        // navigation to its focused swatch, just as Qt's normal focus dispatch.
        QWidget * focus = QApplication::focusWidget();
        if (focus && focus != this && isAncestorOf(focus)
            && (event->key() == Qt::Key_Left || event->key() == Qt::Key_Right
                || event->key() == Qt::Key_Up || event->key() == Qt::Key_Down
                || event->key() == Qt::Key_Return || event->key() == Qt::Key_Enter
                || event->key() == Qt::Key_Escape)) {
            QApplication::sendEvent(focus, event); return;
        }
        QMenu::keyPressEvent(event);
    }
};
class ColorButton : public QToolButton {
    GuiApplication * app;
    QMenu * palette;
    QJsonObject target;
    QString last = "#c00000";
    QStringList recent;
    QList<QAbstractButton *> choices;
    static bool valid(QString const & color) {
        return color.size() == 7 && color.startsWith('#') && QColor(color).isValid();
    }
    QIcon icon(QString const & color, bool letter = false) {
        QPixmap pixmap(letter ? 22 : 24, 24); pixmap.fill(Qt::transparent);
        QPainter painter(&pixmap);
        if (letter) {
            QFont font; font.setBold(true); font.setPixelSize(18); painter.setFont(font);
            painter.setPen(QColor("#242426")); painter.drawText(QRect(0, 0, 22, 20), Qt::AlignCenter, "A");
            painter.fillRect(2, 21, 18, 3, QColor(color));
        } else {
            painter.fillRect(2, 2, 20, 20, QColor(color));
            painter.setPen(QColor("#999999")); painter.drawRect(2, 2, 20, 20);
        }
        return QIcon(pixmap);
    }
    void focusDocument() {
        if (auto * window = app->currentView())
            if (auto * area = window->currentMainWorkArea()) area->setFocus();
    }
    void apply(QString const & color) {
        palette->hide();
        QJsonObject params{{"path", target["path"]}, {"sourceRevision", target["sourceRevision"]},
            {"selection", target["clipboardSelection"]}, {"color", color}};
        QJsonObject const result = target["error"].toBool() ? target : applyCodexColor(app, params);
        if (!result["applied"].toBool()) {
            if (auto * window = app->currentView())
                window->message(qstring_to_ucs4(result["message"].toString()));
            focusDocument(); return;
        }
        if (color != "default") {
            last = color; recent.removeAll(color); recent.prepend(color);
            while (recent.size() > 6) recent.removeLast();
            QSettings settings;
            settings.setValue("codex/fontColor", last);
            settings.setValue("codex/recentFontColors", recent);
            setIcon(icon(last, true));
        }
        focusDocument();
    }
    void watch(QAbstractButton * button) {
        button->setFocusPolicy(Qt::StrongFocus);
        button->installEventFilter(this); choices.append(button);
    }
    void grid(QVBoxLayout * layout, QList<QPair<QString, QString>> const & colors) {
        auto * row = new QGridLayout;
        row->setSpacing(4);
        for (int column = 0; column < 6; ++column) row->setColumnMinimumWidth(column, 30);
        int i = 0;
        for (auto const & color : colors) {
            auto * button = new QToolButton(palette);
            button->setIcon(icon(color.first)); button->setIconSize(QSize(24, 24));
            button->setFixedSize(30, 30);
            button->setToolTip(color.second + " (" + color.first.toUpper() + ")");
            button->setAccessibleName(button->toolTip());
            button->setProperty("color", color.first);
            button->setCheckable(true); button->setChecked(color.first == last);
            watch(button);
            connect(button, &QToolButton::clicked, this, [this, color] {apply(color.first);});
            row->addWidget(button, i / 6, i % 6); ++i;
        }
        layout->addLayout(row);
    }
    void populate() {
        target = captureCodexColorTarget(app);
        choices.clear(); palette->clear();
        auto * widget = new QWidget(palette);
        auto * layout = new QVBoxLayout(widget);
        layout->setContentsMargins(10, 10, 10, 10); layout->setSpacing(8);
        auto * reset = new QPushButton("Default color", widget);
        watch(reset); layout->addWidget(reset);
        connect(reset, &QPushButton::clicked, this, [this] {apply("default");});
        layout->addWidget(new QLabel("Common colors", widget));
        grid(layout, {{"#000000", "Black"}, {"#666666", "Gray"}, {"#ffffff", "White"},
            {"#c00000", "Dark red"}, {"#ff0000", "Red"}, {"#ed7d31", "Orange"},
            {"#ffc000", "Gold"}, {"#548235", "Green"}, {"#008080", "Teal"},
            {"#0000ff", "Blue"}, {"#203864", "Navy"}, {"#7030a0", "Purple"}});
        if (!recent.isEmpty()) {
            layout->addWidget(new QLabel("Recent colors", widget));
            QList<QPair<QString, QString>> colors;
            for (auto const & color : recent) colors.append({color, "Recent color"});
            grid(layout, colors);
        }
        auto * custom = new QPushButton("More colors…", widget);
        watch(custom); layout->addWidget(custom);
        connect(custom, &QPushButton::clicked, this, [this] {
            palette->hide();
            QColor color;
            {
                QColorDialog dialog(QColor(last), app->currentView());
                dialog.setWindowTitle("Font color");
                dialog.setOption(QColorDialog::DontUseNativeDialog);
                // The offscreen engine has no access to the user's real screen.
                for (auto * button : dialog.findChildren<QPushButton *>())
                    if (button->text().remove('&') == QColorDialog::tr("Pick Screen Color").remove('&')) button->hide();
                if (dialog.exec() == QDialog::Accepted) color = dialog.selectedColor();
            }
            if (color.isValid()) apply(color.name()); else focusDocument();
        });
        auto * action = new QWidgetAction(palette); action->setDefaultWidget(widget); palette->addAction(action);
        QPointer<QAbstractButton> first = choices.value(1);
        for (auto * choice : choices) if (choice->property("color") == last) {first = choice; break;}
        QTimer::singleShot(0, this, [this, first] {if (palette->isVisible() && first) first->setFocus();});
    }
    bool eventFilter(QObject * object, QEvent * event) override {
        if (event->type() != QEvent::KeyPress) return QToolButton::eventFilter(object, event);
        auto * key = static_cast<QKeyEvent *>(event);
        auto * current = qobject_cast<QAbstractButton *>(object);
        int const index = choices.indexOf(current);
        if (index < 0) return QToolButton::eventFilter(object, event);
        int offset = 0;
        switch (key->key()) {
        case Qt::Key_Left: offset = -1; break;
        case Qt::Key_Right: offset = 1; break;
        case Qt::Key_Up: offset = -6; break;
        case Qt::Key_Down: offset = 6; break;
        case Qt::Key_Return: case Qt::Key_Enter: current->click(); return true;
        case Qt::Key_Escape: palette->hide(); focusDocument(); return true;
        default: return QToolButton::eventFilter(object, event);
        }
        choices[qBound(0, index + offset, choices.size() - 1)]->setFocus();
        return true;
    }
public:
    ColorButton(GuiApplication * application, QWidget * parent) : QToolButton(parent), app(application) {
        setObjectName("codex-font-color");
        setAccessibleName("Font color"); setFocusPolicy(Qt::NoFocus);
        setPopupMode(QToolButton::MenuButtonPopup);
        QSettings settings;
        QString const saved = settings.value("codex/fontColor").toString();
        if (valid(saved)) last = saved.toLower();
        for (auto const & color : settings.value("codex/recentFontColors").toStringList())
            if (valid(color) && recent.size() < 6 && !recent.contains(color.toLower())) recent.append(color.toLower());
        setIcon(icon(last, true)); setIconSize(QSize(22, 24));
        setToolTip("Font color: click A to apply the last color; open the arrow for the palette");
        palette = new ColorMenu(this); palette->setObjectName("codex-color-palette");
        setMenu(palette);
        connect(palette, &QMenu::aboutToShow, this, [this] {populate();});
        connect(this, &QToolButton::clicked, this, [this] {target = captureCodexColorTarget(app); apply(last);});
    }
};
}

void ensureCodexColorToolbar(GuiApplication * app)
{
    auto * window = app->currentView();
    if (!window) return;
    auto * toolbar = window->findChild<QToolBar *>("standard");
    if (!toolbar || toolbar->actions().isEmpty()) return;
    auto * button = toolbar->findChild<QToolButton *>("codex-font-color");
    if (!button) {
        button = new ColorButton(app, toolbar);
        toolbar->insertWidget(toolbar->actions().value(1), button);
    }
    auto * view = window->documentBufferView();
    bool enabled = view && !view->buffer().isReadonly();
    if (enabled) {
        Cursor const & cursor = view->cursor();
        enabled = cursor.inset().lyxCode() != ERT_CODE && (!cursor.inMathed() || cursor.selection());
    }
    button->setEnabled(enabled);
}
}}
