#include <iostream>

int a();
int b();

int main(int argc, char** argv) {
    std::cout << "Foo" << std::endl;
    std::cout << "A:" << a() << std::endl;
    std::cout << "B:" << b() << std::endl;
}