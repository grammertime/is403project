// Run in the server environment
// someone has to start this program. Right now it is just listening for requests
console.log("Currently running file:", __filename);
try {
// Load environment variables from .env file into memory
require('dotenv').config(); // calls config method on the env file which gives us environment variables
// treat environment variables like constants

const express = require('express'); // making an express object and importing the class
// needed for the session variable 
const session = require("express-session")

let path = require("path"); // path class for images

let bodyParser = require("body-parser") // body parser class, allows to work with the html form in the request
// gets username, password, from request

let app = express(); // server object short for application

const port = process.env.PORT || 2999; // port number and lets us work with the env file

app.use ( // app.use is the express object that is called everytime we run our application. Runs route like an onload
    session( // <-- tells us were creating a session object. Lives on the server side 
        {
    secret: process.env.SESSION_SECRET || 'fallback-secret-key', // keys and values in this session grabs secret key from env file
    resave: false, // resave allows us to save every request if TRUE so FALSE does not save every request only want to save the session once
    saveUninitialized: false, // every time the key is changed it also resaves so FALSE keeps that from happening
        }
    )
); // now have a session object on the server that allows us to store data on the server

const knex = require("knex")({
    client: "pg",
    connection: {
        host : process.env.DB_HOST || "localhost",
        user : process.env.DB_USER || "postgres",
        password : process.env.DB_PASSWORD || "admin",
        database : process.env.DB_NAME || "writinghelper",
        port : process.env.DB_PORT || 5432  // PostgreSQL 16 typically uses port 5434
    }
});

app.use(express.urlencoded({extended: true})); // allows us to work with the FORM using the NAME 

// global authentication middlware (meaning running all the time) - runs on EVERY request
app.use((req, res, next) => {
    // skip authentication for login routes
    if (req.path === '/' || req.path === '/login' || req.path === '/logout') {
        // continue with the request path
        return next(); 
    }
    // check if user is logged in for all other routes
    if (req.session.isLoggedIn) { // if the user is logged in/authenticated
        // notice no return because it will exit anyway
        next(); // user is logged in, continue
    } else { // if the user is not logged in they must do so to access the next page
            res.render("login", { error_message: "Please log in to access this page"})
    } // this keeps track if the user was able to login in a boolean of Truth or False
});



app.set("view engine", "ejs"); // says that we're using ejs pages on our website for imbedding js on server side
// allows for server to send data back to the client
app.set("views", path.join(__dirname, "views")); // Add this

// Add debug logging for all requests
app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
});


app.get('/', (req, res) =>  { // routes for the webpage http://localhost:3000/ <-- is the '/' in the line of code
    if (req.session.isLoggedIn) {        
        res.render("index");
    } 
    else {
        res.render("login", { error_message: "" });
    }
}); // when someone visits the root route

// handle login form submission
app.post('/login', (req, res) => {
    let sName = req.body.username;
    let sPassword = req.body.password;

    knex.select("username", "password")
        .from('user')
        .where("username", sName)
        .andWhere("password", sPassword)
        .then(users => {
            // Check if a user was found with matching username AND password
            if (users.length > 0) {
                req.session.isLoggedIn = true;
                req.session.username = sName;
                res.redirect("index");
            } else {
                // No matching user found
                res.render("login", { error_message: "Invalid login" });
            }
        })
        .catch(err => {
            console.error("Login error:", err);
            res.render("login", { error_message: "Invalid login" });
        });
});

// home page route
app.get('/home', (req, res) => {
    if (!req.session.isLoggedIn) {
        return res.redirect('/');
    }
    res.render('index', { username: req.session.username});
});

// logout route
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.log('Error destroying session:', err);
        }
        res.redirect('/');  
    });
});

console.log("Port value:", port);
app.listen(port, () => { // starts the server listening process
    console.log(`server is running on port ${port}`); // so we know that it's running
}); // can't put this code higher because it won't know what paths to take
// should be the last thing you code
} catch (err) {
    console.error("Server failed to start", err)
}



 
