import React from 'react';
import './App.css';

const EcoFutureLandingPage = () => {
    return (
        <div className="app">
            <header>
                <h1>Welcome to EcoFuture</h1>
            </header>
            <div className="container">
                <section className="hero">
                    <h1>Join the Movement for a Sustainable Future</h1>
                </section>
                <section className="section">
                    <h2>About Us</h2>
                    <p>EcoFuture is dedicated to promoting environmental sustainability through active initiatives and community involvement.</p>
                </section>
                <section className="section">
                    <h2>Our Initiatives</h2>
                    <p>Learn more about the projects we currently support that aim to protect our planet.</p>
                </section>
                <section className="section">
                    <h2>Get Involved</h2>
                    <p>Whether you want to volunteer or make a donation, your help is crucial.</p>
                    <button className='cta-button'>Join the Movement</button>
                </section>
                <section className="section">
                    <h2>Testimonials</h2>
                    <p>“EcoFuture is making a real impact on our community!” - A Supporter</p>
                </section>
                <section className="section">
                    <h2>Blog</h2>
                    <p>Check out our latest articles on environmental topics and learn how to make a difference.</p>
                </section>
                <section className="section">
                    <h2>Contact Us</h2>
                    <form>
                        <input type="text" className="form-input" placeholder="Your Name" required />
                        <input type="email" className="form-input" placeholder="Your Email" required />
                        <textarea className="form-input" placeholder="Your Message" rows="4" required></textarea>
                        <button type="submit" className="cta-button">Send Message</button>
                    </form>
                </section>
            </div>
        </div>
    );
};

export default EcoFutureLandingPage;