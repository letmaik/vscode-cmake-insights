add_subdirectory(subproj)

add_library(foo SHARED a.cc)
add_library(bar STATIC b.cc)
add_library(x STATIC c.cc)
add_library(mod MODULE c.cc)
add_library(obj OBJECT a.cc b.cc)
add_executable(main main.cc)

target_link_libraries(foo x)
target_link_libraries(x obj)
target_link_libraries(main foo bar sub)
