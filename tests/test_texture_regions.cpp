// Compare regional and original texture pyramids, including preview pixels.
#include <QCoreApplication>
#include <QTemporaryDir>
#include <iostream>
#include <stdexcept>
#include "texpyramid.h"

static void require(bool ok, const char *message) {
    if(!ok) throw std::runtime_error(message);
}

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    QTemporaryDir directory;
    try {
        int cases = 0;
        for(QSize size: {QSize(128,127), QSize(6145,193), QSize(32769,65), QSize(1,1)}) {
            for(const char *format: {"png", "jpg"}) {
                for(uint64_t memory: {uint64_t(16384), uint64_t(64*1024*1024)}) {
                    QImage input(size, QImage::Format_ARGB32);
                    for(int y = 0; y < size.height(); ++y)
                        for(int x = 0; x < size.width(); ++x)
                            input.setPixel(x,y,qRgba((x*31+y*17)%256,(x*7+y*97)%256,(x*101+y*3)%256,
                                                    size.width()==1 ? 0 : (x+y)%256));
                    QString filename = directory.path()+"/source."+format;
                    require(input.save(filename,format), "Could not save fixture");
                    nx::TexAtlas eager, regional;
                    eager.cache_max = regional.cache_max = memory;
                    regional.regional = true;
                    std::vector<LoadTexture> files{LoadTexture(filename)};
                    eager.addTextures(files);
                    regional.addTextures(files);
                    require(eager.pyramids[0].fully_transparent == regional.pyramids[0].fully_transparent,
                            "Alpha marker changed");
                    for(int level = 0; level < 9; ++level) {
                        eager.buildLevel(level); regional.buildLevel(level);
                        int w = eager.width(0,level), h = eager.height(0,level);
                        require(w==regional.width(0,level) && h==regional.height(0,level), "LOD dimensions changed");
                        std::vector<QRect> regions;
                        for(QPoint center: {QPoint(0,0),QPoint(w-1,h-1),QPoint(w/2,h/2),QPoint(255,31),QPoint(4095,31)}) {
                            QRect region(center-QPoint(17,13),QSize(41,35));
                            region = region.intersected(QRect(0,0,w,h));
                            if(!region.isEmpty()) { regions.push_back(region); regional.request(0,level,region); }
                        }
                        regional.prepare(level);
                        for(QRect region: regions) {
                            auto expected = eager.read(0,level,region).convertToFormat(QImage::Format_RGB32);
                            auto actual = regional.read(0,level,region).convertToFormat(QImage::Format_RGB32);
                            if(actual != expected) {
                                std::cerr << "Mismatch: " << size.width() << 'x' << size.height() << ' ' << format
                                          << " level " << level << " region " << region.x() << ',' << region.y() << '\n';
                                throw std::runtime_error("Regional cache changed pixels");
                            }
                        }
                        if(level==0 && size.width()>6000) {
                            uint64_t pixels = 0;
                            for(auto &entry: regional.disk) pixels += uint64_t(entry.second.w)*entry.second.h;
                            for(auto &entry: regional.ram)
                                if(!regional.disk.count(entry.first))
                                    pixels += uint64_t(entry.second.image.width())*entry.second.image.height();
                            require(pixels < uint64_t(w)*h/2, "Unused source regions entered the sparse cache");
                        }
                    }
                    std::cout << "PASS regional/reference " << size.width() << 'x' << size.height()
                              << ' ' << format << " memory=" << memory << '\n';
                    ++cases;
                }
            }
        }
        std::cout << "All " << cases << " regional/reference cases passed (9 LODs each).\n";
    } catch(const std::exception &e) { std::cerr << e.what() << '\n'; return 1; }
      catch(const QString &e) { std::cerr << e.toStdString() << '\n'; return 1; }
}
