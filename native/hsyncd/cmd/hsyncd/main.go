package main

import (
	"fmt"
	"os"

	"github.com/t1nk333r/hsync/native/hsyncd/internal/host"
)

var version = "dev"

func main() {
	if err := host.New(version).Run(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
