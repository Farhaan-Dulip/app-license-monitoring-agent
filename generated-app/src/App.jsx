import React from 'react';
import './App.css';

const FeedbackForm = () => {
    const handleStarClick = (event) => {
        const stars = document.querySelectorAll('.star');
        stars.forEach(star => star.classList.remove('selected'));
        for (let i = 0; i < event.target.dataset.value; i++) {
            stars[i].classList.add('selected');
        }
    };

    return (
        <div className="container">
            <h1>Feedback Form</h1>
            <h2>We Value Your Feedback</h2>
            <form>
                <label htmlFor="email">Email:</label>
                <input type="email" id="email" required placeholder="your.email@example.com" />
                <label htmlFor="rating">Rating:</label>
                <div className="rating">
                    <span className="star" data-value="1" onClick={handleStarClick}>★</span>
                    <span className="star" data-value="2" onClick={handleStarClick}>★</span>
                    <span className="star" data-value="3" onClick={handleStarClick}>★</span>
                    <span className="star" data-value="4" onClick={handleStarClick}>★</span>
                    <span className="star" data-value="5" onClick={handleStarClick}>★</span>
                </div>
                <label htmlFor="comments">Comments:</label>
                <textarea id="comments" rows="4" placeholder="Share your thoughts..." required></textarea>
                <button type="submit">Submit Feedback</button>
            </form>
        </div>
    );
};

export default FeedbackForm;