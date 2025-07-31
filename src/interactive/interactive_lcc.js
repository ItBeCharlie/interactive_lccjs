#!/usr/bin/env node

// lcc.js

const fs = require("fs");
const path = require("path");
const Assembler = require("./interactive_assembler");
const Interpreter = require("./interactive_interpreter");
const nameHandler = require("../utils/name.js");
const { generateBSTLSTContent } = require("../utils/genStats.js");

const newline = process.platform === "win32" ? "\r\n" : "\n";

const isTestMode = typeof global.it === "function"; // crude check for Jest

function fatalExit(message, code = 1) {
	if (isTestMode) {
		throw new Error(message);
	} else {
		process.exit(code);
	}
}

class LCC {
	constructor() {
		this.inputFileName = "";
		this.outputFileName = "";
		this.options = {};
		this.args = [];
		this.assembler = null;
		this.interpreter = null;
		this.inputBuffer = "";
		this.generateStats = true;
	}

	main(args) {
		args = args || process.argv.slice(2);

		if (args.length === 0) {
			this.printHelp();
			fatalExit("No input file specified. Printing help message.", 0);
		}

		this.parseArguments(args);

		if (this.args.length === 0) {
			console.error("No input file specified.");
			fatalExit("No input file specified.", 1);
		}

		// If multiple inputs were supplied, the "main input file" is the first one
		this.inputFileName = this.args[0];

		try {
			this.userName = nameHandler.createNameFile(this.inputFileName);
		} catch (error) {
			console.error("Error handling name file:", error.message);
			fatalExit("Error handling name file: " + error.message, 1);
		}

		this.handleSingleFile(this.inputFileName);
	}

	/**
	 * If the input file is not .o, handle it as .hex, .bin, .e, or .a
	 */
	handleSingleFile(infile) {
		const ext = path.extname(infile).toLowerCase();
		switch (ext) {
			case ".hex":
			case ".bin":
				this.assembleFile();
				this.executeFile(false, true, ext);
				break;
			case ".e":
				this.outputFileName = infile;
				this.executeFile(false, false, ext);
				break;
			case ".o":
				// to match feature parity with original LCC, we attempt to link the single .o file
				this.assembleFile();
				break;
			default:
				// Likely an assembly source (e.g. .a or anything else)
				this.assembleFile();
				if (!this.assembler.isObjectModule) {
					this.executeFile(true, true, ext);
				}
				break;
		}
	}

	constructOutputFileName(inputFileName) {
		const parsedPath = path.parse(inputFileName);
		// Remove extension and add '.e'
		return path.format({ ...parsedPath, base: undefined, ext: ".e" });
	}

	printHelp() {
		console.log("Usage: lcc.js <infile>");
		console.log(
			"Optional args: -d -m -r -t -f -x -l<hex loadpt> -o <outfile> -h"
		);
		console.log(
			"   -d:   debug, -m mem display at end, -r: reg display at end"
		);
		console.log("   -f:   full line display, -x: 4 digit hout, -h: help");
		console.log(
			"What lcc.js does depends on the extension in the input file name:"
		);
		console.log("   .hex: execute and output .lst, .bst files");
		console.log("   .bin: execute and output .lst, .bst files");
		console.log("   .e:   execute and output .lst, .bst files");
		console.log("   .o:   link files and output executable file");
		console.log(
			"   .a or other: assemble and output .e or .o, .lst, .bst files"
		);
		console.log(
			"         if a .e file is created, it will also be executed"
		);
		console.log("File types:");
		console.log("   .hex: machine code in ascii hex");
		console.log("   .bin: machine code in ascii binary");
		console.log("   .e:   executable");
		console.log("   .o    linkable object module");
		console.log("   .lst: time-stamped listing in hex and output from run");
		console.log(
			"   .bst: time-stamped listing in binary and output from run"
		);
		console.log("   .a or other: assembler code");
		console.log(`lcc.js Ver 0.1${newline}`);
	}

	parseArguments(args) {
		let i = 0;
		while (i < args.length) {
			let arg = args[i];
			if (arg.startsWith("-")) {
				// Option
				switch (arg) {
					case "-d":
						this.options.debug = true;
						break;
					case "-m":
						this.options.memDisplay = true;
						break;
					case "-r":
						this.options.regDisplay = true;
						break;
					case "-f":
						this.options.fullLineDisplay = true;
						break;
					case "-x":
						this.options.hexOutput = true;
						break;
					case "-t":
						this.options.trace = true;
						break;
					case "-nostats":
						this.options.noStats = true;
						break;
					case "-h":
						this.printHelp();
						fatalExit(
							"Printing help message after -h flag used.",
							0
						);
					default:
						if (arg.startsWith("-l")) {
							// Load point
							this.options.loadPoint = parseInt(
								arg.substr(2),
								16
							);
						} else if (arg === "-o") {
							// Output file name
							i++;
							if (i < args.length) {
								this.outputFileName = args[i];
							} else {
								// individual linking output should occur, but the final
								// link.e file should not be created in this scenario
								console.error("Missing output file name"); // No output file specified after -o
								fatalExit(
									"Missing output file name after -o flag",
									1
								);
							}
						} else {
							console.error(`Unknown option: ${arg}`);
							fatalExit(`Unknown option: ${arg}`, 1);
						}
						break;
				}
			} else {
				// Non-option argument
				this.args.push(arg);
			}
			i++;
		}
	}

	assembleFile() {
		const assembler = new Assembler();

		// Set input and output file names
		assembler.inputFileName = this.inputFileName;
		assembler.outputFileName =
			this.outputFileName ||
			this.constructOutputFileName(this.inputFileName);

		// Update this.outputFileName to match assembler's output
		this.outputFileName = assembler.outputFileName;

		// Store the assembler instance
		this.assembler = assembler;

		try {
			// Run the assembler's main function
			assembler.main([this.inputFileName]);
		} catch (error) {
			console.error(
				`Error assembling ${this.inputFileName}: ${error.message}`
			);
			fatalExit(
				`Error assembling ${this.inputFileName}: ${error.message}`,
				1
			);
		}
	}

	// Will update the listing map to contain the source code for each location in the program
	createListingMap(fileType) {
		let listingMap = {};
		console.log(this.assembler.listing);
		for (let i = 0; i < this.assembler.listing.length; i++) {
			const entry = this.assembler.listing[i];
			switch (fileType) {
				case ".hex":
				case ".bin":
					listingMap[entry.locCtr] = entry;
				break;
				default:
				for(let j = 0; j < entry.codeWords.length; j++) {
					listingMap[entry.locCtr + j] = entry;
				break;
				}
			}
		}

		return listingMap;
	}

	// Executes the output file
	// includeSourceCode: boolean, includeComments: boolean
	// includeSourceCode: whether to include source code in the .lst and .bst files (true when assembling and interpretting .a files)
	// includeComments: whether to include comments in the .lst and .bst files (this option is set to true just for .bin files currently)
	executeFile(includeSourceCode, includeComments, fileType) {
		const interpreter = new Interpreter();

		// Set options in the interpreter
		interpreter.options = this.options;
		interpreter.debugMode = !!this.options.debug;

		// Pass inputBuffer to interpreter
		if (this.inputBuffer) {
			interpreter.inputBuffer = this.inputBuffer;
		}

		// Store the interpreter instance
		this.interpreter = interpreter;

		// Load the executable file
		interpreter.loadExecutableFile(this.outputFileName);

		let lstFileName;
		let bstFileName;

		if (this.generateStats) {
			// After execution, generate .lst and .bst files
			lstFileName = this.outputFileName.replace(/\.e$/, ".lst");
			bstFileName = this.outputFileName.replace(/\.e$/, ".bst");

			console.log(`lst file = ${lstFileName}`);
			console.log(`bst file = ${bstFileName}`);
			console.log(
				"====================================================== Output"
			);
		}

		let listingMap = this.createListingMap(fileType);
		console.log(listingMap);

		// Run the interpreter
		try {
			interpreter.run(listingMap);
			if (this.generateStats) {
				console.log(); // Ensure cursor moves to the next line
			}
		} catch (error) {
			console.error(
				`Error running ${this.outputFileName}: ${error.message}`
			);
			fatalExit(
				`Error running ${this.outputFileName}: ${error.message}`,
				1
			);
		}

		if (this.generateStats) {
			// Generate .lst and .bst files using genStats.js
			const lstContent = generateBSTLSTContent({
				isBST: false,
				interpreter: interpreter,
				assembler:
					includeSourceCode || includeComments
						? this.assembler
						: null,
				userName: this.userName,
				inputFileName: this.inputFileName,
				includeComments: includeComments,
			});

			const bstContent = generateBSTLSTContent({
				isBST: true,
				interpreter: interpreter,
				assembler:
					includeSourceCode || includeComments
						? this.assembler
						: null,
				userName: this.userName,
				inputFileName: this.inputFileName,
				includeComments: includeComments,
			});

			// Write the .lst and .bst files
			fs.writeFileSync(lstFileName, lstContent);
			fs.writeFileSync(bstFileName, bstContent);
		} else {
			// console.clear();
		}
	}
}

module.exports = LCC;

if (require.main === module) {
	const lcc = new LCC();
	lcc.main();
}
